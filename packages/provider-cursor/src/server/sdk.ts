// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// createRequire loads the disk-backed SDK and adjacent chunks even from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);

type CursorSdkModule = typeof import("@cursor/sdk");
type CursorSdkSqliteModule = typeof import("@cursor/sdk/sqlite");

let loadedCursorSdk: CursorSdkModule | undefined;
function loadCursorSdk(): CursorSdkModule {
  loadedCursorSdk ??= requireCursorSdk("@cursor/sdk") as CursorSdkModule;
  return loadedCursorSdk;
}

let loadedCursorSdkSqlite: CursorSdkSqliteModule | undefined;
function loadCursorSdkSqlite(): CursorSdkSqliteModule {
  loadedCursorSdkSqlite ??= requireCursorSdk("@cursor/sdk/sqlite") as CursorSdkSqliteModule;
  return loadedCursorSdkSqlite;
}

/**
 * The SDK entry and its separate sqlite entry are expensive to parse and
 * initialize. Providers stay lazy so a server with Cursor disabled never pays
 * for either one.
 */
export const cursorSdk = {
  get Agent() {
    return loadCursorSdk().Agent;
  },
  get AuthenticationError() {
    return loadCursorSdk().AuthenticationError;
  },
  get ConfigurationError() {
    return loadCursorSdk().ConfigurationError;
  },
  get createAgentPlatform() {
    return loadCursorSdk().createAgentPlatform;
  },
  get Cursor() {
    return loadCursorSdk().Cursor;
  },
  get CursorSdkError() {
    return loadCursorSdk().CursorSdkError;
  },
  get InMemoryCredentialStore() {
    return loadCursorSdk().InMemoryCredentialStore;
  },
  get SqliteLocalAgentStore() {
    return loadCursorSdkSqlite().SqliteLocalAgentStore;
  },
};
