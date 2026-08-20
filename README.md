# opencode-tps

An OpenCode TUI plugin that displays request-level session and per-model tokens-per-second metrics in the sidebar.

## Features

- Weighted TPS for the complete session
- Separate metrics by provider, model, and variant
- Output and reasoning token accounting
- Time to first token included
- Tool execution and wait time excluded
- Historical session estimates after restart
- No telemetry or network requests

## Requirements

- OpenCode 1.18 or newer within major version 1

## Installation

After the package is published to npm:

```bash
opencode plugin @nextzhou/opencode-tps -g
```

Restart OpenCode, then press `Ctrl+X`, followed by `B`, to open the sidebar.

For local development, add the project directory to the `plugin` array in your global `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-tps"]
}
```

## Metric

The plugin calculates a weighted average:

```text
TPS = sum(output tokens + reasoning tokens) / sum(model request durations)
```

A request duration begins when OpenCode starts a model step and ends with its final text, reasoning, or tool-input event. This includes request startup and time to first token. Message completion and tool-result timestamps are not used, so tool execution and waiting between model steps are excluded.

When precise stream events are unavailable for an older message, the plugin estimates its request window from the assistant message creation timestamp through the final persisted text or reasoning part. Pure tool-call historical steps without those timestamps are omitted.

## Development

```bash
bun install
bun run check
bun run pack:check
```

Individual commands:

```bash
bun run format
bun run lint
bun run typecheck
bun test
bun run build
```

## Project Structure

```text
src/tui.ts                  OpenCode event adapter and sidebar renderer
src/session-tps-state.ts    Framework-independent TPS tracking and aggregation
tests/                      Behavior tests
docs/requirements.md        Product scope and metric contract
docs/releasing.md           npm release process
```

## License

[MIT](LICENSE)
