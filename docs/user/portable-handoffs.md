# Context in portable handoffs

When you switch providers mid-thread, continue after a portable restart, or fork a thread the provider cannot resume natively, T3 Code transfers a budgeted selection of conversation history to the new provider session.

## What transfers

- Short conversations transfer intact.
- Longer conversations prioritize the original request, recent user/assistant turns (including partial work from interrupted turns), and key activity like command outcomes.
- Your new prompt is never shortened to make history fit.
- Codex receives historical messages directly when supported; other providers receive attributed conversation context.
- Reasoning traces, raw tool-call state, and attachments are not copied.
- Omitted history is referenced so the agent can retrieve saved messages on demand using T3 Code's thread-reading tool. Still, repeat any critical constraint in your next message if you want to be sure.

## Context limits and configuration

If the target session doesn't have enough context room, T3 Code automatically starts a fresh provider session with a bounded history selection and sends your request—no manual `/compact` needed. If your request and attachments alone exceed the model's window, shorten the message or choose a larger-context model.

- **History budget**: Operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` (default `16000`, range `1024`–`64000`) to adjust the initial history allowance. Imported history has a separate 64,000-byte ceiling.
- **Fallback estimates**: When a model doesn't report capacity, T3 Code assumes a 128,000-token window, reserves at least 16,000 tokens (or 25%) for instructions/tools/work, and conservatively estimates 1 token per UTF-8 byte, 8,192 tokens per image, and 4,096 tokens per other attachment.
- Running background work stays intact during recovery—let it finish or stop it before retrying a handoff.

## Compact with another model

Choose native compaction or compaction with another model from the context menu. Custom compaction
summarizes saved history with the selected model, then starts fresh provider context in the same
thread. Your model, worktree, settings, and draft stay in place, and earlier messages remain
available.

- Useful when the original provider hit a usage limit or its prompt cache expired; the summarizer
  uses its own provider allowance.
- Attachments, hidden reasoning, and native tool state are not transferred. If generation fails or
  the conversation changes meanwhile, the previous context stays intact.
- It runs on the server: closing the menu, switching threads, or disconnecting does not cancel it.
  One compaction runs per thread at a time, from any device.
- Long histories are summarized in parts; the menu shows progress, a failed part is retried once,
  and **Cancel** stops it any time before the summary is saved.

## Cold prompt caches

Claude threads show an estimated prompt-cache lifetime. An expired or unknown cache blocks a new
turn unless you allow an uncached read for that message, or compact with another model instead. The
estimate cannot guarantee a cache hit: model or prompt changes may invalidate the cache earlier.

Agents and scheduled tasks cannot confirm an uncached read. In **Settings → Threads**, choose
whether their sends to a cold Claude thread are blocked, allowed, or compacted first.
