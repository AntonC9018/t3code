import { describe, expect, it, vi } from "vite-plus/test";

const loader = vi.hoisted(() => {
  const main = {
    Agent: Symbol("Agent"),
    AuthenticationError: Symbol("AuthenticationError"),
    ConfigurationError: Symbol("ConfigurationError"),
    createAgentPlatform: Symbol("createAgentPlatform"),
    Cursor: Symbol("Cursor"),
    CursorSdkError: Symbol("CursorSdkError"),
    InMemoryCredentialStore: Symbol("InMemoryCredentialStore"),
  };
  const sqlite = { SqliteLocalAgentStore: Symbol("SqliteLocalAgentStore") };
  const require = vi.fn((specifier: string) => {
    if (specifier === "@cursor/sdk") return main;
    if (specifier === "@cursor/sdk/sqlite") return sqlite;
    throw new Error(`Unexpected SDK module load: ${specifier}`);
  });
  return { main, require, sqlite };
});

vi.mock("node:module", () => ({ createRequire: () => loader.require }));

async function importSdk() {
  vi.resetModules();
  loader.require.mockClear();
  return import("./sdk.ts");
}

describe("cursorSdk", () => {
  it("loads the main SDK only when an export is read", async () => {
    const { cursorSdk } = await importSdk();
    expect(loader.require).not.toHaveBeenCalled();

    const agent = cursorSdk.Agent;
    expect(agent).toBe(loader.main.Agent);
    expect(loader.require).toHaveBeenCalledTimes(1);
    expect(loader.require).toHaveBeenCalledWith("@cursor/sdk");

    expect(cursorSdk.Agent).toBe(agent);
    expect(loader.require).toHaveBeenCalledTimes(1);
  });

  it("loads the sqlite entry separately when its export is read", async () => {
    const { cursorSdk } = await importSdk();
    expect(loader.require).not.toHaveBeenCalled();

    const store = cursorSdk.SqliteLocalAgentStore;
    expect(store).toBe(loader.sqlite.SqliteLocalAgentStore);
    expect(loader.require).toHaveBeenCalledTimes(1);
    expect(loader.require).toHaveBeenCalledWith("@cursor/sdk/sqlite");
    expect(loader.require).not.toHaveBeenCalledWith("@cursor/sdk");
  });
});
