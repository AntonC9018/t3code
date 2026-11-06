import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import catalog from "./catalog.json" with { type: "json" };

export type SpeechModel = {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly languages: readonly string[];
  readonly accuracy: number;
  readonly speed: number;
  readonly benchmark: NonNullable<EnvironmentSpeechModel["benchmark"]>;
  readonly recommended: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsLanguageDetection: boolean;
  readonly supportsTranslation: boolean;
  readonly supportsRecognitionHints: boolean;
};

// The worker probes `supports("vocabulary")` once a model is loaded; this labels the catalog.
const VOCABULARY_MODEL = /^handy-computer\/(whisper-|Breeze-ASR-25-gguf$)/;

// Scores remain required by the wire schema but are not displayed.
export const SPEECH_MODELS: readonly SpeechModel[] = catalog.models.map((model) => ({
  ...model,
  accuracy: 0,
  speed: 0,
  supportsRecognitionHints: VOCABULARY_MODEL.test(model.id),
}));

export const DEFAULT_SPEECH_MODEL_ID = "handy-computer/parakeet-unified-en-0.6b-gguf";
export const getSpeechModel = (modelId: string): SpeechModel | undefined =>
  SPEECH_MODELS.find((model) => model.id === modelId);

export { effectiveSpeechLanguage } from "@t3tools/shared/speech";
