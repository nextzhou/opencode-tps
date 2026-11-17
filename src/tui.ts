import { Plugin } from "@opencode/plugin/tui";
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import {
  SessionTpsTracker,
  type ModelIdentity,
  type TpsSample,
} from "./session-tps-state.js";

type Context = Plugin.Context;

// V2 event names consumed by this plugin (source: @opencode/client@2.3.0
// types). Typing the `on` wrapper with this union makes a misspelled name a
// compile error instead of a silent no-op in the TUI.
type OpenCodeEventName =
  | "session.step.started"
  | "session.text.ended"
  | "session.reasoning.ended"
  | "session.tool.input.ended"
  | "session.step.ended"
  | "session.step.failed"
  | "session.revert.staged"
  | "session.revert.cleared"
  | "session.revert.committed"
  | "session.deleted";

type SidebarView = {
  sessionID: string;
  content: TextRenderable;
};

// V2 payloads ride on `{ created?, data }` with the properties in
// `event.data`. No JSX on purpose: the host transpiler emits `react` by
// default (it does not read the tsconfig jsxImportSource) and
// `@opentui/solid` is not mapped, while `@opentui/core` is — the renderables
// are built imperatively, same as the V1 plugin.
type TuiEvent = { created?: number; data?: unknown };
type ModelRef = { providerID: string; id: string; variant?: string };
type AssistantMessageLike = {
  id: string;
  type: string;
  error?: unknown;
  model: ModelRef;
  tokens: { output: number; reasoning: number };
  time: { created: number; completed?: number; streamed?: number };
  content?: { type: string; time?: { completed?: number } }[];
};
type StepStartedData = {
  sessionID: string;
  assistantMessageID: string;
  model: ModelIdentity;
  started: number;
};
type OutputEndedData = { sessionID: string; assistantMessageID: string };
type StepEndedData = {
  sessionID: string;
  assistantMessageID: string;
  tokens: { output: number; reasoning: number };
};
type RevertStagedData = { sessionID: string; revert: { messageID: string } };
type RevertCommittedData = { sessionID: string; to: string };

// One token per module load: after a /reload the module is re-evaluated and
// renderables from the previous generation may still be alive; ids must stay
// unique across generations.
const instance = Math.random().toString(36).slice(2, 8);
let renderID = 0;

function formatTps(tps: number): string {
  return tps.toFixed(1);
}

function modelIdentity(message: AssistantMessageLike): ModelIdentity {
  return {
    providerID: message.model.providerID,
    id: message.model.id,
    variant: message.model.variant,
  };
}

function setup(context: Context) {
  // The server loads every discovered plugin with its generic context (no
  // `ui`): this plugin is TUI-only, so it no-ops cleanly there instead of
  // throwing and polluting the log.
  if (!context.ui) return () => {};

  const tracker = new SessionTpsTracker();
  const views = new Set<SidebarView>();
  const completedIDs = new Map<string, Set<string>>();

  const location = () => context.location ?? context.data.location.default();

  const modelName = (model: ModelIdentity): string => {
    const info = (context.data.location.model.list(location()) ?? []).find(
      (item) =>
        item.providerID === model.providerID &&
        (item.modelID === model.id || item.id === model.id),
    );
    return info?.name ?? model.id;
  };

  const summaryText = (
    summary: ReturnType<SessionTpsTracker["summary"]>,
  ): string => {
    if (summary.total.samples === 0) return "Waiting for completed output";
    const lines = [`Session avg  ${formatTps(summary.total.tps)} tok/s`];
    for (const metric of summary.byModel) {
      lines.push(`${modelName(metric.model)}  ${formatTps(metric.tps)} tok/s`);
    }
    return lines.join("\n");
  };

  const currentModel = (
    sessionID: string,
    messageID: string,
  ): ModelIdentity | undefined => {
    const message = (
      context.data.session.message.list(sessionID) as AssistantMessageLike[]
    ).find((item) => item.id === messageID);
    return message?.type === "assistant" ? modelIdentity(message) : undefined;
  };

  const historicalSnapshot = (
    sessionID: string,
    revertedMessageID?: string,
  ): { samples: TpsSample[]; includedMessageIDs?: ReadonlySet<string> } => {
    const messages = context.data.session.message.list(
      sessionID,
    ) as AssistantMessageLike[];
    const revertIndex = revertedMessageID
      ? messages.findIndex((message) => message.id === revertedMessageID)
      : -1;
    const visibleMessages =
      revertIndex >= 0 ? messages.slice(0, revertIndex) : messages;
    const samples: TpsSample[] = [];
    for (const message of visibleMessages) {
      if (message.type !== "assistant" || message.error || !message.tokens) {
        continue;
      }
      const outputEndedAt = message.time?.completed;
      if (outputEndedAt == null) continue;
      if (outputEndedAt <= message.time.created) continue;
      samples.push({
        messageID: message.id,
        model: modelIdentity(message),
        tokens: message.tokens.output + message.tokens.reasoning,
        durationMs: outputEndedAt - message.time.created,
        completedAt: outputEndedAt,
      });
    }
    return {
      samples,
      includedMessageIDs:
        revertIndex >= 0
          ? new Set(visibleMessages.map((message) => message.id))
          : undefined,
    };
  };

  const sessionSummary = (
    sessionID: string,
    revertOverride?: string | null,
  ) => {
    const revertedMessageID =
      revertOverride === undefined
        ? context.data.session.get(sessionID)?.revert?.messageID
        : (revertOverride ?? undefined);
    const historical = historicalSnapshot(sessionID, revertedMessageID);
    return tracker.summary(
      sessionID,
      historical.samples,
      historical.includedMessageIDs,
    );
  };

  const refresh = (sessionID: string, revertOverride?: string | null) => {
    const text = summaryText(sessionSummary(sessionID, revertOverride));
    for (const view of views) {
      view.content.content = text;
    }
  };

  const unsubs: (() => void)[] = [];
  const on = <Name extends OpenCodeEventName>(
    type: Name,
    handler: (event: TuiEvent) => void,
  ) => {
    unsubs.push(context.data.on(type, handler));
  };

  // The claim returns a disposer: keeping it lets the cleanup (/reload,
  // plugin disable) retire the block instead of leaving the previous
  // generation rendered next to the new one.
  const dissolveClaim = context.ui.slot({
    append: "sidebar.content",
    render: ({ sessionID }: { sessionID: string }) => {
      const id = ++renderID;
      const container = new BoxRenderable(context.renderer, {
        id: `opencode-tps-${instance}-${id}`,
        flexDirection: "column",
      });
      const title = new TextRenderable(context.renderer, {
        id: `opencode-tps-title-${instance}-${id}`,
        content: "Performance",
        fg: context.theme.text.base,
        attributes: TextAttributes.BOLD,
      });
      const content = new TextRenderable(context.renderer, {
        id: `opencode-tps-content-${instance}-${id}`,
        content: summaryText(sessionSummary(sessionID)),
        fg: context.theme.text.muted,
        wrapMode: "word",
      });
      container.add(title);
      container.add(content);
      views.add({ sessionID, content });
      return container;
    },
  });

  on("session.step.started", (event) => {
    const data = event.data as StepStartedData;
    tracker.startStep({
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      model: data.model,
      timestamp: data.started,
    });
  });

  // V2 carries no timestamp in `*.ended` payloads: `event.created` is the
  // host's emission time for the event, which is the output end.
  const finishOutput = (event: TuiEvent) => {
    const data = event.data as OutputEndedData;
    tracker.finishOutput({
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      timestamp: event.created as number,
    });
  };
  on("session.text.ended", finishOutput);
  on("session.reasoning.ended", finishOutput);
  on("session.tool.input.ended", finishOutput);

  on("session.step.ended", (event) => {
    const data = event.data as StepEndedData;
    const sample = tracker.completeStep({
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      model: currentModel(data.sessionID, data.assistantMessageID),
      outputTokens: data.tokens.output,
      reasoningTokens: data.tokens.reasoning,
    });
    if (sample) {
      const ids = completedIDs.get(data.sessionID) ?? new Set<string>();
      ids.add(sample.messageID);
      completedIDs.set(data.sessionID, ids);
    }
    refresh(data.sessionID);
  });

  on("session.step.failed", (event) => {
    const data = event.data as {
      sessionID: string;
      assistantMessageID: string;
    };
    tracker.failStep(data.assistantMessageID);
  });

  on("session.revert.staged", (event) => {
    const data = event.data as RevertStagedData;
    refresh(data.sessionID, data.revert.messageID);
  });

  on("session.revert.cleared", (event) => {
    const data = event.data as { sessionID: string };
    refresh(data.sessionID, null);
  });

  on("session.revert.committed", (event) => {
    const data = event.data as RevertCommittedData;
    refresh(data.sessionID, data.to);
  });

  return () => {
    for (const unsubscribe of unsubs) unsubscribe();
    dissolveClaim();
  };
}

export default Plugin.define({ id: "opencode-tps", setup });
