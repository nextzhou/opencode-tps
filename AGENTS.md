# Agent Guidance

## Architecture

- Keep OpenCode event adaptation, historical reconstruction, and imperative sidebar rendering in `src/tui.ts`; keep tracking and aggregation framework-independent in `src/session-tps-state.ts`.
- TypeScript uses NodeNext resolution. Relative source imports must name the emitted `.js` file, including from tests.

## Metric Contract

- TPS is weighted throughput: total output plus reasoning tokens divided by total generation-window time. Never average per-step TPS values.
- A step's window runs from its first text, reasoning, or tool-input delta through its latest matching end event. Never use message-completion, tool-result, tool-execution, or inter-step waiting time.
- Historical estimates use only persisted text/reasoning part timestamps; omit historical pure tool-call steps. A precise event sample replaces the estimate with the same assistant message ID.
- Metric-semantic changes require contract tests and a matching update to `docs/requirements.md`. The plugin must remain free of telemetry and network requests.

## Compatibility

- Keep the external plugin renderer imperative until OpenCode resolves packaged-CLI reactive TSX issue anomalyco/opencode#39986. Loading a separate SolidJS or OpenTUI runtime can prevent repainting or break renderer context identity.
- OpenCode's current slot types omit raw Renderables even though the host runtime supports them. Keep the narrow type assertion at the slot boundary rather than spreading assertions through the codebase.

## Workflow

- Use Bun; CI pins Bun 1.3.14 and installs with `bun install --frozen-lockfile`.
- Run one test file with `bun test tests/session-tps-state.test.ts`; focus one test with `bun test tests/session-tps-state.test.ts -t "<test name>"`.
- Before delivery, run `bun run check`; its required order is format check, lint, typecheck, tests, then build. Run `bun run pack:check` for packaging or release changes.
