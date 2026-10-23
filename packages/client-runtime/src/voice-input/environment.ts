import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as Effect from "effect/Effect";
import { SPEECH_STREAM_PATH } from "@t3tools/contracts";
import type {
  SpeechAcceleration,
  SpeechModelUnloadTimeout,
  SpeechTranscriptionOptions,
  SpeechPostProcessingOptions,
} from "@t3tools/contracts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

const VOICE_REQUEST_TIMEOUT_MS = 30 * 60_000;
const SPEECH_BATCH_CHUNK_SECONDS = 30;
const SPEECH_SAMPLE_RATE = 16_000;
const SPEECH_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;
type EnvironmentApiClient<G extends "voice" | "auth"> = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<G>>
>;
type EnvironmentApiUrls<G extends "voice" | "auth"> = ReturnType<
  typeof makeEnvironmentHttpApiUrlBuilder
>[G];

const request = Effect.fn("clientRuntime.voiceInput.environmentRequest")(function* <
  A,
  E,
  G extends "voice" | "auth",
>(input: {
  readonly group: G;
  readonly prepared: PreparedConnection;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: (urls: EnvironmentApiUrls<G>) => string;
  readonly run: (input: {
    readonly client: EnvironmentApiClient<G>;
    readonly headers: { readonly authorization?: string; readonly dpop?: string };
  }) => Effect.Effect<A, E>;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    group: input.group,
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    method: input.method,
    url: input.path,
    timeoutMs: VOICE_REQUEST_TIMEOUT_MS,
    requestInit: { redirect: "error" },
    request: input.run,
  });
});

export const getEnvironmentSpeechStatus = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.status(),
    run: ({ client, headers }) => client.status({ headers }),
  });

export const getEnvironmentSpeechStreamUrl = (prepared: PreparedConnection) => {
  let endpoint = prepared.httpBaseUrl;
  return request({
    group: "auth",
    prepared,
    method: "POST",
    path: (urls) => {
      const ticketUrl = urls.webSocketTicket();
      endpoint = new URL(ticketUrl).origin;
      return ticketUrl;
    },
    run: ({ client, headers }) => client.webSocketTicket({ headers }),
  }).pipe(
    Effect.map(({ ticket }) => {
      const url = new URL(SPEECH_STREAM_PATH, endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      return url.toString();
    }),
  );
};

export const getEnvironmentSpeechModels = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.models(),
    run: ({ client, headers }) => client.models({ headers }),
  });

export const prepareEnvironmentSpeechModel = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.prepareModel(),
    run: ({ client, headers }) => client.prepareModel({ headers }),
  });

export const downloadEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.downloadModel(),
    run: ({ client, headers }) => client.downloadModel({ headers, payload: { modelId } }),
  });

export const selectEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.selectModel(),
    run: ({ client, headers }) => client.selectModel({ headers, payload: { modelId } }),
  });

export const cancelEnvironmentSpeechModelDownload = (
  prepared: PreparedConnection,
  modelId: string,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.cancelModelDownload(),
    run: ({ client, headers }) => client.cancelModelDownload({ headers, payload: { modelId } }),
  });

const transcribeEnvironmentPcmRequest = (
  prepared: PreparedConnection,
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.transcribe(),
    run: ({ client, headers }) =>
      client.transcribe({
        headers,
        payload: encodeSpeechPcmRequest(pcm, options),
      }),
  });

const speechBatchChunkBytes =
  SPEECH_BATCH_CHUNK_SECONDS * SPEECH_SAMPLE_RATE * SPEECH_BYTES_PER_SAMPLE;
const speechBoundarySearchBytes = 5 * SPEECH_SAMPLE_RATE * SPEECH_BYTES_PER_SAMPLE;
const speechBoundaryFrameBytes = 320 * SPEECH_BYTES_PER_SAMPLE;

const nextSpeechBatchBoundary = (pcm: Uint8Array, offset: number) => {
  const target = Math.min(offset + speechBatchChunkBytes, pcm.byteLength);
  if (target === pcm.byteLength) return target;
  const searchStart = Math.max(offset + speechBatchChunkBytes - speechBoundarySearchBytes, offset);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bestBoundary = target;
  let lowestEnergy = Infinity;
  for (
    let frame = searchStart;
    frame + speechBoundaryFrameBytes <= target;
    frame += speechBoundaryFrameBytes
  ) {
    let energy = 0;
    for (let sample = frame; sample < frame + speechBoundaryFrameBytes; sample += 4) {
      const value = view.getFloat32(sample, true);
      energy += value * value;
    }
    if (energy < lowestEnergy) {
      lowestEnergy = energy;
      bestBoundary = frame + speechBoundaryFrameBytes / 2;
    }
  }
  return bestBoundary;
};

/** Split long recordings into contiguous short requests; each request stays within backend limits. */
export const transcribeEnvironmentPcm = (
  prepared: PreparedConnection,
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
) =>
  Effect.gen(function* () {
    const transcripts: string[] = [];
    let offset = 0;
    while (offset < pcm.byteLength) {
      const end = nextSpeechBatchBoundary(pcm, offset);
      const result = yield* transcribeEnvironmentPcmRequest(
        prepared,
        pcm.subarray(offset, end),
        options,
      );
      if (result.text.trim()) transcripts.push(result.text.trim());
      offset = end;
    }
    return { text: transcripts.join(" ") };
  });

export const postProcessEnvironmentTranscript = (
  prepared: PreparedConnection,
  transcript: string,
  draft: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  },
  options: SpeechPostProcessingOptions,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.postProcess(),
    run: ({ client, headers }) =>
      client.postProcess({
        headers,
        payload: { transcript, draft, options },
      }),
  });

export const updateEnvironmentSpeechAcceleration = (
  prepared: PreparedConnection,
  acceleration: SpeechAcceleration,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.updateAcceleration(),
    run: ({ client, headers }) => client.updateAcceleration({ headers, payload: { acceleration } }),
  });

export const updateEnvironmentSpeechModelUnloadTimeout = (
  prepared: PreparedConnection,
  timeout: SpeechModelUnloadTimeout,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.updateModelUnloadTimeout(),
    run: ({ client, headers }) =>
      client.updateModelUnloadTimeout({ headers, payload: { timeout } }),
  });

export const removeEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.removeModel(),
    run: ({ client, headers }) => client.removeModel({ headers, payload: { modelId } }),
  });
