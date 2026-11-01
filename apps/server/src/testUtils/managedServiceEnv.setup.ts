import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";

// Agents inside a managed T3 service inherit its home, launcher context and Handy speech
// endpoint; CI has none of them.
for (const name of [
  "T3CODE_HOME",
  "T3_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
  "T3_SPEECH_HANDY_URL",
  "T3_SPEECH_HANDY_TOKEN",
]) {
  delete process.env[name];
}
