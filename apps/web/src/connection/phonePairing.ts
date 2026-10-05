import type {
  AuthEnvironmentScope,
  AuthPairingCredentialResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { makeEnvironmentHttpApiGroupClient } from "@t3tools/client-runtime/rpc";
import { FetchHttpClient } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runtime } from "../lib/runtime";
import { environmentCatalog } from "./catalog";
import { desktopLocalBackendId, readDesktopSecondaryBootstraps } from "./desktopLocal";
import { environmentSession } from "../state/session";
import {
  createServerPairingCredential,
  revokeServerPairingLink,
} from "../environments/primary/auth";

export interface PhonePairingCredential extends AuthPairingCredentialResult {
  readonly companions: readonly {
    readonly url: string;
    readonly environmentId: EnvironmentId;
    readonly pairingId: string;
  }[];
}

class PhonePairingConnectionError extends Schema.TaggedError<PhonePairingConnectionError>()(
  "PhonePairingConnectionError",
  {},
) {
  override get message(): string {
    return "The WSL backend has no authenticated bearer session.";
  }
}

async function companionAuth<A, E>(
  environmentId: EnvironmentId,
  run: (
    client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"auth">>>,
    headers: { authorization: string },
  ) => Effect.Effect<A, E>,
) {
  return runtime.runPromise(
    Effect.gen(function* () {
      // A settings-only visit may never have mounted this stream. A synchronous
      // atom read returns its initial None even when the backend is connected.
      const prepared = yield* AtomRegistry.toStreamResult(
        appAtomRegistry,
        environmentSession.preparedConnectionAtom(environmentId),
      ).pipe(
        Stream.filter(Option.isSome),
        Stream.map((value) => value.value),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      if (prepared.httpAuthorization?._tag !== "Bearer") {
        return yield* Effect.fail(new PhonePairingConnectionError());
      }
      const token = prepared.httpAuthorization.token;
      const client = yield* makeEnvironmentHttpApiGroupClient(prepared.httpBaseUrl, "auth");
      return yield* run(client, { authorization: `Bearer ${token}` });
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "error",
        credentials: "omit",
      }),
      Effect.timeout("10 seconds"),
    ),
  );
}

export async function createPhonePairingCredential(input: {
  readonly label?: string;
  readonly scopes?: readonly AuthEnvironmentScope[];
}): Promise<PhonePairingCredential> {
  const companions: PhonePairingCredential["companions"][number][] = [];
  const entries = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries;
  try {
    for (const bootstrap of readDesktopSecondaryBootstraps()) {
      if (!bootstrap.id.startsWith("wsl:")) continue;
      if (!bootstrap.remoteHttpBaseUrl)
        throw new Error("Enable Tailscale HTTPS and wait for WSL before creating a phone QR.");
      const entry = [...entries.values()].find(
        (entry) => desktopLocalBackendId(entry.target) === bootstrap.id,
      );
      if (!entry)
        throw new Error(
          "The WSL backend is still connecting. Try creating the QR again once it is ready.",
        );
      const grant = await companionAuth(entry.target.environmentId, (client, headers) =>
        client.pairingCredential({ headers, payload: input }),
      );
      companions.push({
        environmentId: entry.target.environmentId,
        pairingId: grant.id,
        url: setPairingTokenOnUrl(new URL(bootstrap.remoteHttpBaseUrl), grant.credential).href,
      });
    }
    return { ...(await createServerPairingCredential(input)), companions };
  } catch (error) {
    await Promise.allSettled(companions.map((companion) => revokeCompanionPairing(companion)));
    throw error;
  }
}

function revokeCompanionPairing(companion: PhonePairingCredential["companions"][number]) {
  return companionAuth(companion.environmentId, (client, headers) =>
    client.revokePairingLink({ headers, payload: { id: companion.pairingId } }),
  );
}

export async function revokePhonePairingCredential(id: string, created?: PhonePairingCredential) {
  await revokeServerPairingLink(id);
  if (created) await Promise.all(created.companions.map(revokeCompanionPairing));
}
