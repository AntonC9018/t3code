import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { chooseAudioDestination } from "../../speech/voiceConsent";

const mocks = vi.hoisted(() => ({
  rerender: null as null | (() => Promise<void>),
  voiceCapability: true as boolean | undefined,
  statusRequests: vi.fn(),
  toast: vi.fn(),
  cancel: vi.fn(),
  listModels: vi.fn(),
  saveWords: vi.fn(),
  saveClient: vi.fn(),
  saveTranslation: vi.fn(),
  speechStatus: {
    supportsTranslation: false,
    translateToEnglish: false,
    effectiveLanguage: "en",
  },
  scope: null as null | {
    target: { projectId: string } | null;
    scope: { label: string; kind: string; members: { id: string }[]; environmentIds: string[] };
    search: { project: string };
    selectScope: ReturnType<typeof vi.fn>;
    connectedEnvironments: { environmentId: string }[];
    environments: unknown[];
    groups: unknown[];
    targets: unknown[];
  },
  projectWords: [] as { term: string; aliases: string[] }[],
  customWords: [] as { term: string; aliases: string[] }[],
  connection: {},
  settings: {
    voiceTranscriptionEnvironmentId: null as string | null,
    voiceMicrophone: "",
    speechLanguage: "auto",
  },
}));
vi.mock("@t3tools/client-runtime/voice-input", async (original) => ({
  ...(await original<object>()),
  getEnvironmentSpeechStatus: () => {
    mocks.statusRequests();
    return Promise.resolve({
      supported: true,
      acceleration: "auto",
      language: "auto",
      ...mocks.speechStatus,
      gpuDevices: [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }],
      customWords: mocks.customWords,
      projectCustomWords: mocks.projectWords,
    });
  },
  updateEnvironmentSpeechFillerWordRemoval: () => Promise.resolve({ supported: true }),
  updateEnvironmentSpeechCustomWords: mocks.saveWords,
  updateEnvironmentSpeechTranslation: mocks.saveTranslation,
  getEnvironmentSpeechModels: () =>
    mocks.listModels() ??
    Promise.resolve({
      models: [
        {
          id: "model",
          name: "Model",
          languages: ["en"],
          supportsLanguageDetection: false,
          supportsTranslation: false,
          state: "downloading",
          size: 100,
        },
      ],
    }),
  cancelEnvironmentSpeechModelDownload: mocks.cancel,
}));
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<object>()),
  useOptionalSettingsScope: () => mocks.scope,
}));
vi.mock("../../hooks/useSettings", async (original) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  return {
    ...(await original<object>()),
    useClientSettings: (select?: (settings: unknown) => unknown) => {
      const settings = {
        ...DEFAULT_CLIENT_SETTINGS,
        ...mocks.settings,
        speechCustomWords: mocks.customWords,
      };
      return select ? select(settings) : settings;
    },
    useClientSettingsHydrated: () => true,
    updateClientSettings: async (patch: Record<string, unknown>) => {
      mocks.saveClient(patch);
      if (patch.speechCustomWords)
        mocks.customWords = patch.speechCustomWords as typeof mocks.customWords;
      Object.assign(mocks.settings, patch);
      await mocks.rerender?.();
    },
  };
});
vi.mock("./useScopedSettings", async (original) => ({
  ...(await original<object>()),
  useScopedSettings: () => ({ speechProjectCustomWords: mocks.projectWords }),
  useUpdateScopedSettings:
    () => async (patch: { speechProjectCustomWords: typeof mocks.projectWords }) => {
      mocks.saveWords(patch);
      mocks.projectWords = patch.speechProjectCustomWords;
      await mocks.rerender?.();
    },
}));
vi.mock("../../lib/runtime", async (original) => ({
  ...(await original<object>()),
  runtime: { runPromise: (value: unknown) => value },
}));
vi.mock("../../state/environments", async (original) => {
  const environment = () => ({
    environmentId: "environment",
    label: "My Computer",
    serverConfig: {
      environment: { capabilities: { voiceTranscription: mocks.voiceCapability } },
    },
  });
  return {
    ...(await original<object>()),
    usePrimaryEnvironmentId: () => "environment",
    useEnvironment: (id: string | null) => (id === "environment" ? environment() : undefined),
    useEnvironments: () => ({ environments: [environment()] }),
  };
});
vi.mock("../../state/session", async (original) => {
  const Option = await import("effect/Option");
  return {
    ...(await original<object>()),
    usePreparedConnection: () => Option.some(mocks.connection),
    useEnvironmentScope: () => true,
    useEnvironmentsWithScope: (targets: readonly { environmentId: string }[]) =>
      new Set(targets.map((target) => target.environmentId)),
  };
});
vi.mock("../../localApi", async (original) => ({
  ...(await original<object>()),
  ensureLocalApi: vi.fn(),
}));
vi.mock("../ui/toast", async (original) => ({
  ...(await original<object>()),
  toastManager: { add: mocks.toast },
}));
// The page header reads scope groups that this panel-level test does not provide.
vi.mock("./SettingsScopeSentence", async (original) => ({
  ...(await original<object>()),
  SettingsScopeSentence: () => null,
}));
vi.mock("./VoicePostProcessingSettings", async (original) => ({
  ...(await original<object>()),
  VoicePostProcessingSettings: () => null,
}));
vi.mock("./TranscriptionTest", async (original) => ({
  ...(await original<object>()),
  TranscriptionTest: ({ modelName }: { modelName: string }) => <span>{modelName}</span>,
}));
vi.mock("./MicrophoneTest", async (original) => ({
  ...(await original<object>()),
  MicrophoneTest: ({ microphoneControl }: { microphoneControl: ReactNode }) => microphoneControl,
}));
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

function setup() {
  mocks.rerender = null;
  mocks.voiceCapability = true;
  mocks.statusRequests.mockClear();
  mocks.toast.mockReset();
  mocks.cancel.mockReset();
  mocks.listModels.mockReset();
  mocks.saveWords.mockReset();
  mocks.saveClient.mockReset();
  mocks.saveTranslation.mockReset();
  mocks.speechStatus = {
    supportsTranslation: false,
    translateToEnglish: false,
    effectiveLanguage: "en",
  };
  mocks.customWords = [];
  mocks.projectWords = [];
  mocks.scope = null;
  mocks.connection = {};
  chooseAudioDestination({ kind: "environment", environmentId: "environment" as EnvironmentId });
  mocks.settings.voiceTranscriptionEnvironmentId = null;
  mocks.settings.voiceMicrophone = "";
  mocks.settings.speechLanguage = "auto";
}

async function mount() {
  const screen = await render(<VoiceSettingsPanel />);
  mocks.rerender = () => screen.rerender(<VoiceSettingsPanel />);
  return screen;
}

const audioGrant = (): { destination: unknown } | null =>
  JSON.parse(window.localStorage.getItem("t3code:voice-audio-grant:v1") ?? "null");
const texts = (root: Element, selector: string) =>
  Array.from(root.querySelectorAll(selector), (element) => element.textContent ?? "");
const normalizedText = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");
const modelDescriptions = (screen: Screen) =>
  texts(screen.container, "p").filter((text) => text.endsWith(" description"));

const model = (overrides: Record<string, unknown>) => ({
  languages: ["en"],
  supportsLanguageDetection: false,
  state: "installed",
  active: false,
  recommended: false,
  supportsStreaming: false,
  size: 100,
  accuracy: 90,
  speed: 90,
  ...overrides,
});

it("shows translation for capable models and updates the client preference", async () => {
  setup();
  mocks.speechStatus = {
    supportsTranslation: true,
    translateToEnglish: false,
    effectiveLanguage: "fr",
  };
  mocks.saveTranslation.mockResolvedValue({
    supported: true,
    acceleration: "auto",
    language: "fr",
    gpuDevices: [],
    customWords: [],
    removeFillerWords: true,
    ...mocks.speechStatus,
    translateToEnglish: true,
  });
  mocks.listModels.mockResolvedValue({
    models: [
      model({
        id: "model",
        name: "Translation Model",
        description: "French speech",
        languages: ["en", "fr"],
        supportsTranslation: true,
        active: true,
      }),
    ],
  });
  await using screen = await mount();
  const toggle = screen.getByRole("switch", { name: "Translate to English" });
  await expect.element(toggle).toBeEnabled();
  // The switch has no box without the app's theme variables, so drive it directly.
  await act(() => (toggle.element() as HTMLElement).click());
  expect(mocks.saveClient).toHaveBeenCalledWith({ speechTranslateToEnglish: true });
});

it("ignores a previous environment model response", async () => {
  setup();
  let resolve!: (value: { models: unknown[] }) => void;
  const pending = { promise: new Promise<{ models: unknown[] }>((done) => (resolve = done)) };
  mocks.listModels.mockReturnValueOnce(pending.promise);
  await using screen = await mount();
  mocks.connection = {};
  await screen.rerender(<VoiceSettingsPanel />);
  const cancel = screen.getByRole("button", { name: "Cancel Model download" });
  await expect.element(cancel).toBeInTheDocument();
  resolve({ models: [] });
  await pending.promise;
  await expect.element(cancel).toBeInTheDocument();
});

it("shows friendly labels for default voice options", async () => {
  setup();
  await using screen = await mount();
  await expect
    .element(screen.getByLabelText("Transcription environment"))
    .toHaveTextContent("My Computer (Primary)");
  await expect.element(screen.getByLabelText("Microphone")).toHaveTextContent("System default");
  await expect
    .element(screen.getByLabelText("Transcription acceleration"))
    .toHaveTextContent("Auto");
  expect(screen.container.textContent).not.toContain("primary-environment");
  expect(screen.container.textContent).not.toContain("system-default");
  await expect.element(screen.getByRole("switch", { name: "Translate to English" })).toBeDisabled();
  await userEvent.click(screen.getByLabelText("Transcription acceleration"));
  await expect.element(page.getByRole("option", { name: "Test GPU" })).toBeInTheDocument();
});

it("shows saved words as tags with misspelling controls in popovers", async () => {
  setup();
  mocks.customWords = [
    { term: "T3 Code", aliases: ["tea three code"] },
    { term: "Codex", aliases: [] },
  ];
  await using screen = await mount();
  await expect.element(screen.getByLabelText("Dictionary entries")).toBeInTheDocument();
  const wordTag = screen.getByRole("button", { name: "Edit misspellings for T3 Code" });
  await expect.element(wordTag).toHaveTextContent("T3 Code(1)");
  await expect
    .element(screen.getByRole("button", { name: "Edit misspellings for Codex" }))
    .toBeInTheDocument();
  await userEvent.click(wordTag);
  await expect.element(page.getByRole("button", { name: "Remove T3 Code" })).toBeInTheDocument();
  await expect.element(page.getByLabelText("Transcribed as for T3 Code")).toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Remove alias tea three code from T3 Code" }))
    .toBeInTheDocument();
});

it("bulk adds normalized words and reports skipped entries", async () => {
  setup();
  mocks.customWords = [{ term: "T3 Code", aliases: ["tee three"] }];
  const words = [
    ...mocks.customWords,
    { term: "New Name", aliases: [] },
    { term: "<Other>", aliases: [] },
  ];
  mocks.saveWords.mockResolvedValue({
    supported: true,
    acceleration: "auto",
    language: "auto",
    effectiveLanguage: "en",
    gpuDevices: [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }],
    customWords: words,
  });
  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Add multiple words" }));
  await userEvent.fill(
    screen.getByLabelText("Words to add"),
    `New   Name\nT3 Code\nTEE THREE\nnew name\n<Other>\n${"x".repeat(51)}`,
  );
  const preview = () => normalizedText(screen.getByRole("status").element());
  await expect.poll(preview).toContain("2 words ready to add");
  await expect.poll(preview).toContain("3 duplicates");
  await expect.poll(preview).toContain("1 over 50 characters");
  await userEvent.click(screen.getByRole("button", { name: "Add 2 words", exact: true }));
  expect(mocks.saveClient).toHaveBeenCalledWith({ speechCustomWords: words });
  await expect.element(screen.getByLabelText("Words to add")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Edit misspellings for New Name" }))
    .toBeInTheDocument();
});

it("limits bulk additions to the remaining dictionary capacity", async () => {
  setup();
  mocks.customWords = Array.from({ length: 99 }, (_, index) => ({
    term: `Word ${index}`,
    aliases: [],
  }));
  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Add multiple words" }));
  await userEvent.fill(screen.getByLabelText("Words to add"), "First\nSecond\nThird");
  const preview = () => normalizedText(screen.getByRole("status").element());
  await expect.poll(preview).toContain("1 word ready to add");
  await expect.poll(preview).toContain("2 over the 100-word limit");
});

it("shows models for the selected language while keeping the active model summary", async () => {
  setup();
  mocks.listModels.mockResolvedValue({
    models: [
      model({
        id: "english",
        name: "English Model",
        description: "English speech",
        active: true,
        recommended: true,
      }),
      model({
        id: "french",
        name: "French Model",
        description: "French speech",
        languages: ["fr"],
        state: "downloadable",
      }),
    ],
  });
  await using screen = await mount();
  const spans = () => texts(screen.container, "span");
  await expect.poll(spans).toContain("English Model");
  expect(spans()).not.toContain("French Model");
  await expect.element(screen.getByLabelText("Transcription language")).toBeDisabled();
  await expect.element(screen.getByText("This model only supports English.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "All", exact: true }));
  await expect.poll(spans).toContain("French Model");
  expect(spans()).toContain("English Model");
  await expect.element(screen.getByText("All models", { exact: true })).toBeInTheDocument();
  await userEvent.fill(screen.getByLabelText("Search transcription models"), "French");
  await expect.poll(spans).toContain("French Model");
  await userEvent.click(screen.getByRole("button", { name: "Clear model search" }));
  await userEvent.click(screen.getByRole("button", { name: "French", exact: true }));
  await expect.poll(spans).toContain("French Model");
  expect(spans()).toContain("English Model");
});

it("orders supported languages by speaker ranking, then alphabetically", async () => {
  setup();
  mocks.listModels.mockResolvedValue({
    models: [
      model({
        id: "multilingual",
        name: "Multilingual Model",
        description: "Multilingual speech",
        languages: ["ca", "es", "ar", "hi", "en", "de", "af"],
        supportsLanguageDetection: true,
        active: true,
      }),
    ],
  });
  await using screen = await mount();
  const picker = screen.getByLabelText("Transcription language");
  await expect.element(picker).toBeEnabled();
  await userEvent.click(picker);
  await expect.element(page.getByRole("option", { name: "Auto" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  const languages = () =>
    texts(screen.getByLabelText("Browse transcription models by language").element(), "button");
  await expect
    .poll(languages)
    .toEqual(["All", "English", "Hindi", "Spanish", "German", "Afrikaans", "Arabic", "Catalan"]);
  await userEvent.fill(screen.getByLabelText("Search languages"), "ar");
  await expect.poll(languages).toEqual(["Arabic"]);
  await userEvent.click(screen.getByRole("button", { name: "Clear language search" }));
  await expect.poll(() => languages().length).toBe(8);
});

it.each([
  { preference: "auto", languages: ["en", "de", "es", "fr"], expected: "English" },
  { preference: "ja", languages: ["en", "de", "es", "fr"], expected: "English" },
  { preference: "auto", languages: ["fr", "de"], expected: "French" },
])(
  "shows the effective language without Auto for $preference on $languages",
  async ({ preference, languages, expected }) => {
    setup();
    mocks.settings.speechLanguage = preference;
    mocks.listModels.mockResolvedValue({
      models: [
        model({
          id: "multilingual",
          name: "Multilingual Model",
          description: "Multilingual speech",
          languages,
          active: true,
        }),
      ],
    });
    await using screen = await mount();
    const picker = screen.getByLabelText("Transcription language");
    await expect.element(picker).toHaveTextContent(expected);
    await userEvent.click(picker);
    await expect.element(page.getByRole("option", { name: "German" })).toBeInTheDocument();
    expect(page.getByRole("option", { name: "Auto" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("option", { name: "German" }));
    expect(mocks.saveClient).toHaveBeenCalledWith({ speechLanguage: "de" });
    await expect.element(picker).toHaveTextContent("German");
  },
);

it("puts the active model first, then installed and downloading models", async () => {
  setup();
  const named = (name: string, state: string, active = false) =>
    model({ id: name, name, description: `${name} description`, state, active });
  mocks.listModels.mockResolvedValue({
    models: [
      named("Available", "downloadable"),
      named("Downloading", "downloading"),
      named("Installed", "installed"),
      named("Active", "installed", true),
    ],
  });
  await using screen = await mount();
  await expect
    .poll(() => modelDescriptions(screen))
    .toEqual([
      "Active description",
      "Installed description",
      "Downloading description",
      "Available description",
    ]);
  const search = screen.getByLabelText("Search transcription models");
  await userEvent.fill(search, "installed");
  await expect.poll(() => modelDescriptions(screen)).toEqual(["Installed description"]);
  await userEvent.fill(search, "missing");
  await expect.element(screen.getByText("No models match your search.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear model search" }));
  await expect.element(search).toHaveValue("");
});

it("uses Handy's editorial ranks within each model state", async () => {
  setup();
  const ranked = (slug: string, name: string, state: string) =>
    model({ id: `handy-computer/${slug}-gguf`, name, description: `${name} description`, state });
  mocks.listModels.mockResolvedValue({
    models: [
      ranked("canary-180m-flash", "Rank 3", "installed"),
      ranked("Fun-ASR-MLT-Nano-2512", "Rank 10", "downloadable"),
      ranked("parakeet-unified-en-0.6b", "Rank 1", "installed"),
      ranked("Voxtral-Mini-4B-Realtime-2602", "Rank 6", "downloadable"),
    ],
  });
  await using screen = await mount();
  await expect
    .poll(() => modelDescriptions(screen))
    .toEqual([
      "Rank 1 description",
      "Rank 3 description",
      "Rank 6 description",
      "Rank 10 description",
    ]);
});

it("sorts unranked models by recommendation, accuracy, speed, then name", async () => {
  setup();
  const scored = (name: string, accuracy: number, speed: number, recommended = false) =>
    model({
      id: name,
      name,
      description: `${name} description`,
      state: "downloadable",
      recommended,
      accuracy,
      speed,
    });
  mocks.listModels.mockResolvedValue({
    models: [
      scored("Zulu", 80, 70),
      scored("Alpha", 80, 70),
      scored("Faster", 80, 90),
      scored("Accurate", 90, 50),
      scored("Recommended", 70, 50, true),
    ],
  });
  await using screen = await mount();
  await expect
    .poll(() => modelDescriptions(screen))
    .toEqual([
      "Recommended description",
      "Accurate description",
      "Faster description",
      "Alpha description",
      "Zulu description",
    ]);
});

it("shows cancellation errors without clearing the download state", async () => {
  setup();
  mocks.cancel.mockImplementation(() => Promise.reject(new Error("connection lost")));
  await using screen = await mount();
  const cancel = screen.getByRole("button", { name: "Cancel Model download" });
  await userEvent.click(cancel);
  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "connection lost" }),
    ),
  );
  await expect.element(cancel).toBeInTheDocument();
});

it("saves project words through the originating project scope without copying personal words", async () => {
  setup();
  mocks.scope = {
    target: { projectId: "project-one" },
    scope: {
      label: "T3 Code",
      kind: "project",
      members: [{ id: "project-one" }],
      environmentIds: ["environment"],
    },
    search: { project: "project-one" },
    selectScope: vi.fn(),
    connectedEnvironments: [{ environmentId: "environment" }],
    environments: [],
    groups: [],
    targets: [],
  };
  mocks.customWords = [{ term: "GitHub", aliases: ["get hub"] }];
  mocks.projectWords = [{ term: "Effect", aliases: [] }];
  mocks.saveWords.mockResolvedValue({
    supported: true,
    acceleration: "auto",
    language: "auto",
    effectiveLanguage: "en",
    gpuDevices: [],
    customWords: mocks.customWords,
    projectCustomWords: [...mocks.projectWords, { term: "Parakeet", aliases: [] }],
  });
  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "View misspellings for GitHub" }));
  await expect.element(page.getByText("get hub")).toBeInTheDocument();
  expect(page.getByRole("button", { name: "Remove GitHub" }).elements()).toHaveLength(0);
  expect(page.getByLabelText("Transcribed as for GitHub").elements()).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Edit personal dictionary" }));
  expect(mocks.scope.selectScope).toHaveBeenCalledWith({ project: undefined, checkout: undefined });
  await userEvent.keyboard("{Escape}");
  const input = screen.getByLabelText("Add a word or phrase");
  await userEvent.fill(input, "github");
  await userEvent.keyboard("{Enter}");
  expect(mocks.saveWords).not.toHaveBeenCalled();
  await userEvent.fill(input, "Parakeet");
  await userEvent.keyboard("{Enter}");
  expect(mocks.saveWords).toHaveBeenCalledWith({
    speechProjectCustomWords: [
      { term: "Effect", aliases: [] },
      { term: "Parakeet", aliases: [] },
    ],
  });
  expect(mocks.saveClient).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  "does not request voice status or models from an older environment (%s)",
  async (capability) => {
    setup();
    mocks.voiceCapability = capability;
    await using screen = await mount();
    await expect
      .poll(() => normalizedText(screen.container))
      .toContain("Update its T3 Code server to use dictation.");
    expect(mocks.statusRequests).not.toHaveBeenCalled();
    expect(mocks.listModels).not.toHaveBeenCalled();
  },
);

it("grants and revokes sending microphone audio from the settings switch", async () => {
  setup();
  chooseAudioDestination(null);
  await using screen = await mount();
  const toggle = screen.getByRole("switch", { name: "Send microphone audio" });
  await expect.element(toggle).not.toBeChecked();
  await act(() => (toggle.element() as HTMLElement).click());
  expect(audioGrant()?.destination).toEqual({
    kind: "environment",
    environmentId: "environment",
  });
  await act(() => (toggle.element() as HTMLElement).click());
  expect(audioGrant()).toBeNull();
});

it("keeps a missing destination selected", async () => {
  setup();
  chooseAudioDestination({ kind: "environment", environmentId: "missing" as EnvironmentId });
  await using screen = await mount();
  await expect
    .element(screen.getByLabelText("Transcription environment"))
    .toHaveTextContent("Selected environment (Unavailable)");
});

it("keeps punctuation in a saved dictionary term and its alias", async () => {
  setup();
  await using screen = await mount();
  await userEvent.fill(screen.getByLabelText("Add a word or phrase"), "O'Reilly");
  await userEvent.keyboard("{Enter}");
  expect(mocks.saveClient).toHaveBeenCalledWith({
    speechCustomWords: [{ term: "O'Reilly", aliases: [] }],
  });
  mocks.saveClient.mockClear();
  mocks.customWords = [{ term: "O'Reilly", aliases: [] }];
  await screen.rerender(<VoiceSettingsPanel />);
  await userEvent.click(screen.getByRole("button", { name: "Edit misspellings for O'Reilly" }));
  await userEvent.fill(page.getByLabelText("Transcribed as for O'Reilly"), '"Oh Really"');
  await userEvent.keyboard("{Enter}");
  expect(mocks.saveClient).toHaveBeenCalledWith({
    speechCustomWords: [{ term: "O'Reilly", aliases: ['"Oh Really"'] }],
  });
});
