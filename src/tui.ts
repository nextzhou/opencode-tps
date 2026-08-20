import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import type {
  TuiHostSlotMap,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
} from "@opencode-ai/plugin/tui";
import type { AssistantMessage } from "@opencode-ai/sdk/v2";
import {
  SessionTpsTracker,
  type ModelIdentity,
  type SessionTpsSummary,
  type TpsSample,
} from "./session-tps-state.js";

type SidebarView = {
  sessionID: string;
  content: TextRenderable;
};

type HistoricalSnapshot = {
  samples: TpsSample[];
  includedMessageIDs?: ReadonlySet<string>;
};

let renderID = 0;

function modelIdentity(message: AssistantMessage): ModelIdentity {
  return {
    providerID: message.providerID,
    id: message.modelID,
    variant: message.variant,
  };
}

function historicalSnapshot(
  api: TuiPluginApi,
  sessionID: string,
  revertedMessageID?: string,
): HistoricalSnapshot {
  const messages = api.state.session.messages(sessionID);
  const revertIndex = revertedMessageID
    ? messages.findIndex((message) => message.id === revertedMessageID)
    : -1;
  const visibleMessages =
    revertIndex >= 0 ? messages.slice(0, revertIndex) : messages;
  const samples: TpsSample[] = [];
  for (const message of visibleMessages) {
    if (
      message.role !== "assistant" ||
      message.error ||
      !message.time.completed
    ) {
      continue;
    }

    const windows = api.state.part(message.id).flatMap((part) => {
      if (part.type !== "text" && part.type !== "reasoning") return [];
      if (!part.time?.end || part.time.end <= part.time.start) return [];
      return [{ start: part.time.start, end: part.time.end }];
    });
    if (windows.length === 0) continue;

    const firstOutputAt = Math.min(...windows.map((window) => window.start));
    const lastOutputAt = Math.max(...windows.map((window) => window.end));
    samples.push({
      messageID: message.id,
      model: modelIdentity(message),
      tokens: message.tokens.output + message.tokens.reasoning,
      durationMs: lastOutputAt - firstOutputAt,
      completedAt: message.time.completed,
    });
  }
  return {
    samples,
    includedMessageIDs:
      revertIndex >= 0
        ? new Set(visibleMessages.map((message) => message.id))
        : undefined,
  };
}

function variantName(variant: string): string {
  return variant
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function modelName(api: TuiPluginApi, model: ModelIdentity): string {
  const provider = api.state.provider.find(
    (item) => item.id === model.providerID,
  );
  const name = provider?.models[model.id]?.name ?? model.id;
  return model.variant ? `${name} ${variantName(model.variant)}` : name;
}

function formatTps(tps: number): string {
  return tps.toFixed(1);
}

function summaryText(api: TuiPluginApi, summary: SessionTpsSummary): string {
  if (summary.total.samples === 0) return "Waiting for completed output";

  const rows = summary.byModel.map((metric) => ({
    metric,
    baseName: modelName(api, metric.model),
  }));
  const duplicateNames = new Set(
    rows
      .map((row) => row.baseName)
      .filter((name, index, names) => names.indexOf(name) !== index),
  );
  const lines = [`Session avg  ${formatTps(summary.total.tps)} tok/s`];
  for (const { metric, baseName } of rows) {
    const provider = api.state.provider.find(
      (item) => item.id === metric.model.providerID,
    );
    const name = duplicateNames.has(baseName)
      ? `${baseName} (${provider?.name ?? metric.model.providerID})`
      : baseName;
    lines.push(`${name}  ${formatTps(metric.tps)} tok/s`);
  }
  return lines.join("\n");
}

function currentModel(
  api: TuiPluginApi,
  sessionID: string,
  messageID: string,
): ModelIdentity | undefined {
  const message = api.state.session
    .messages(sessionID)
    .find((item) => item.id === messageID);
  return message?.role === "assistant" ? modelIdentity(message) : undefined;
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-tps",
  async tui(api) {
    const tracker = new SessionTpsTracker();
    const views = new Set<SidebarView>();

    const sessionSummary = (
      sessionID: string,
      revertOverride?: string | null,
    ) => {
      const revertedMessageID =
        revertOverride === undefined
          ? api.state.session.get(sessionID)?.revert?.messageID
          : (revertOverride ?? undefined);
      const historical = historicalSnapshot(api, sessionID, revertedMessageID);
      return tracker.summary(
        sessionID,
        historical.samples,
        historical.includedMessageIDs,
      );
    };

    const refresh = (sessionID: string, revertOverride?: string | null) => {
      const text = summaryText(api, sessionSummary(sessionID, revertOverride));
      for (const view of views) {
        if (view.content.isDestroyed) {
          views.delete(view);
          continue;
        }
        if (view.sessionID === sessionID) view.content.content = text;
      }
    };

    api.slots.register({
      order: 150,
      slots: {
        sidebar_content(
          context: TuiSlotContext,
          props: TuiHostSlotMap["sidebar_content"],
        ) {
          const id = ++renderID;
          const container = new BoxRenderable(api.renderer, {
            id: `opencode-tps-${id}`,
            flexDirection: "column",
          });
          const title = new TextRenderable(api.renderer, {
            id: `opencode-tps-title-${id}`,
            content: "Performance",
            fg: context.theme.current.text,
            attributes: TextAttributes.BOLD,
          });
          const content = new TextRenderable(api.renderer, {
            id: `opencode-tps-content-${id}`,
            content: summaryText(api, sessionSummary(props.session_id)),
            fg: context.theme.current.textMuted,
            wrapMode: "word",
          });
          container.add(title);
          container.add(content);
          views.add({ sessionID: props.session_id, content });

          // OpenTUI accepts raw Renderables in Solid slots at runtime, while
          // the current OpenCode public type only declares JSX.Element.
          return container as never;
        },
      },
    });

    api.event.on("session.next.step.started", (event) => {
      tracker.startStep({
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        model: event.properties.model,
      });
    });

    const observeOutput = (input: {
      sessionID: string;
      assistantMessageID: string;
      timestamp: number;
    }) => {
      tracker.observeOutput({
        sessionID: input.sessionID,
        messageID: input.assistantMessageID,
        timestamp: input.timestamp,
      });
    };
    api.event.on("session.next.text.delta", (event) =>
      observeOutput(event.properties),
    );
    api.event.on("session.next.reasoning.delta", (event) =>
      observeOutput(event.properties),
    );
    api.event.on("session.next.tool.input.delta", (event) =>
      observeOutput(event.properties),
    );

    const finishOutput = (input: {
      sessionID: string;
      assistantMessageID: string;
      timestamp: number;
    }) => {
      tracker.finishOutput({
        sessionID: input.sessionID,
        messageID: input.assistantMessageID,
        timestamp: input.timestamp,
      });
    };
    api.event.on("session.next.text.ended", (event) =>
      finishOutput(event.properties),
    );
    api.event.on("session.next.reasoning.ended", (event) =>
      finishOutput(event.properties),
    );
    api.event.on("session.next.tool.input.ended", (event) =>
      finishOutput(event.properties),
    );

    api.event.on("session.next.step.ended", (event) => {
      tracker.completeStep({
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        model: currentModel(
          api,
          event.properties.sessionID,
          event.properties.assistantMessageID,
        ),
        outputTokens: event.properties.tokens.output,
        reasoningTokens: event.properties.tokens.reasoning,
        completedAt: event.properties.timestamp,
      });
      refresh(event.properties.sessionID);
    });
    api.event.on("session.next.step.failed", (event) => {
      tracker.failStep(event.properties.assistantMessageID);
    });
    api.event.on("session.next.revert.staged", (event) => {
      refresh(event.properties.sessionID, event.properties.revert.messageID);
    });
    api.event.on("session.next.revert.cleared", (event) => {
      refresh(event.properties.sessionID, null);
    });
    api.event.on("session.next.revert.committed", (event) => {
      refresh(event.properties.sessionID, event.properties.messageID);
    });
    api.event.on("message.removed", (event) => {
      tracker.removeMessage(
        event.properties.sessionID,
        event.properties.messageID,
      );
      refresh(event.properties.sessionID);
    });
  },
};

export default plugin;
