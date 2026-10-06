import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AuthCreatePairingCredentialInput } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  primary: vi.fn(),
  companion: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));
vi.mock("./catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: Atom.make({
      entries: new Map([["wsl", { target: { environmentId: "wsl-environment" } }]]),
    }),
  },
}));
vi.mock("./desktopLocal", () => ({
  desktopLocalBackendId: () => "wsl:ubuntu",
  readDesktopSecondaryBootstraps: () => [
    {
      id: "wsl:ubuntu",
      remoteHttpBaseUrl: "https://fixture.example.ts.net:8443/",
    },
  ],
}));
vi.mock("../state/session", async () => {
  // The real prepared-state stream also starts at None and resolves only
  // after a subscriber mounts it. No chat view has mounted it in this case.
  const atom = Atom.runtime(Layer.empty).atom(
    Effect.promise(async () =>
      Option.some({
        httpBaseUrl: "http://127.0.0.1:4321/",
        httpAuthorization: { _tag: "Bearer", token: "fixture-bearer" },
      }),
    ),
    { initialValue: Option.none() },
  );
  return {
    environmentSession: { preparedConnectionAtom: () => atom },
  };
});
vi.mock("../environments/primary/auth", () => ({
  createServerPairingCredential: mocks.primary,
  revokeServerPairingLink: mocks.revoke,
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({
  makeEnvironmentHttpApiGroupClient: () =>
    Effect.succeed({
      pairingCredential: mocks.companion,
      revokePairingLink: () => Effect.void,
    }),
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { createPhonePairingCredential } from "./phonePairing";

const decodePairingInput = Schema.decodeUnknownEffect(AuthCreatePairingCredentialInput);
const decodePairingInputSync = Schema.decodeUnknownSync(AuthCreatePairingCredentialInput);

afterEach(() => {
  appAtomRegistry.reset();
  vi.clearAllMocks();
});

describe("desktop phone pairing", () => {
  it.each([undefined, "", "   ", "  Phone  "])(
    "accepts an optional client label %j for both backends",
    async (label) => {
      mocks.companion.mockImplementation(({ payload }) =>
        decodePairingInput(payload).pipe(Effect.as({ id: "wsl-grant", credential: "wsl-pairing" })),
      );
      mocks.primary.mockImplementation(async (payload) => {
        decodePairingInputSync(payload);
        return { id: "primary-grant", credential: "primary-pairing" };
      });

      await createPhonePairingCredential(label === undefined ? {} : { label });
      const expected = label?.trim() ? { label: label.trim() } : {};
      expect(mocks.companion.mock.calls[0]?.[0].payload).toEqual(expected);
      expect(mocks.primary).toHaveBeenCalledWith(expected);
    },
  );

  it("pairs WSL before the primary even when no view has observed its prepared state", async () => {
    const calls: string[] = [];
    mocks.companion.mockImplementation(({ headers }) => {
      expect(headers).toEqual({ authorization: "Bearer fixture-bearer" });
      calls.push("wsl");
      return Effect.succeed({ id: "wsl-grant", credential: "wsl-pairing" });
    });
    mocks.primary.mockImplementation(async () => {
      calls.push("primary");
      return { id: "primary-grant", credential: "primary-pairing" };
    });

    const result = await createPhonePairingCredential({ label: "Phone" });
    expect(calls).toEqual(["wsl", "primary"]);
    expect(result.companions).toEqual([
      {
        environmentId: "wsl-environment",
        pairingId: "wsl-grant",
        url: "https://fixture.example.ts.net:8443/#token=wsl-pairing",
      },
    ]);
  });
});
