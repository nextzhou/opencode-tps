import { expect, mock, test } from "bun:test";

mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}));

class FakeBoxRenderable {
  readonly children: FakeTextRenderable[] = [];

  add(child: FakeTextRenderable): void {
    this.children.push(child);
  }
}

class FakeTextRenderable {
  content: string;
  isDestroyed = false;

  constructor(_renderer: unknown, options: { content: string }) {
    this.content = options.content;
  }
}

mock.module("@opentui/core", () => ({
  BoxRenderable: FakeBoxRenderable,
  TextAttributes: { BOLD: 1 },
  TextRenderable: FakeTextRenderable,
}));

const { default: plugin } = (await import("../src/tui.js")) as {
  setup: (ctx: unknown) => () => void;
};

type TestMessage = Record<string, unknown>;
type EventHandler = (event: { created?: number; data?: unknown }) => void;

const gptModel = {
  providerID: "openai",
  modelID: "gpt-5.4",
  id: "gpt-5.4",
  name: "GPT-5.4",
};
const openaiProvider = { id: "openai", name: "OpenAI" };

// `completed` is optional: a message without an output end has no historical
// estimate yet, so it renders as "Waiting for completed output".
function assistantMessage(id: string, tokens: number, completed?: number) {
  return {
    id,
    sessionID: "session",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5.4" },
    tokens: {
      input: 0,
      output: tokens,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created: (completed ?? 0) - 1000,
      ...(completed !== undefined ? { completed } : {}),
    },
    content: [{ type: "text", text: "response" }] as Record<string, unknown>[],
  };
}

function renderSidebar(input: {
  messages: TestMessage[];
  revertedMessageID?: string;
}) {
  const handlers = new Map<string, EventHandler>();
  const claims: Record<string, unknown>[] = [];
  let slotDissolved = false;
  const context = {
    location: undefined,
    renderer: {},
    theme: { text: { base: "white", muted: "gray" } },
    data: {
      on: (type: string, handler: EventHandler) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
      session: {
        get: () =>
          input.revertedMessageID
            ? { revert: { messageID: input.revertedMessageID } }
            : undefined,
        message: { list: () => input.messages },
      },
      location: {
        default: () => "loc",
        model: { list: () => [gptModel] },
        provider: { list: () => [openaiProvider] },
      },
    },
    ui: {
      slot: (claim: Record<string, unknown>) => {
        claims.push(claim);
        return () => {
          slotDissolved = true;
        };
      },
    },
  };
  const cleanup = plugin.setup(context);
  const claim = claims.find((entry) => entry.append === "sidebar.content");
  if (!claim) throw new Error("sidebar.content claim was not registered");
  const render = claim.render as (props: { sessionID: string }) => unknown;
  const box = render({ sessionID: "session" }) as FakeBoxRenderable;
  const content = box.children[1];
  if (!content) throw new Error("sidebar content was not rendered");
  return { content, handlers, cleanup, isDissolved: () => slotDissolved };
}

test("setup is a no-op without a UI context", () => {
  const cleanup = plugin.setup({ data: { on: () => () => {} } });
  expect(typeof cleanup).toBe("function");
  cleanup();
});

test("measures from request start to output end", () => {
  const messages = [assistantMessage("assistant-live", 100)];
  const { content, handlers } = renderSidebar({ messages });

  expect(content.content).toBe("Waiting for completed output");
  handlers.get("session.step.started")?.({
    data: {
      sessionID: "session",
      assistantMessageID: "assistant-live",
      model: { providerID: "openai", id: "gpt-5.4" },
      started: 1000,
    },
  });
  handlers.get("session.text.ended")?.({
    created: 3000,
    data: {
      sessionID: "session",
      assistantMessageID: "assistant-live",
      ordinal: 0,
      text: "...",
    },
  });
  handlers.get("session.step.ended")?.({
    created: 9000,
    data: {
      sessionID: "session",
      assistantMessageID: "assistant-live",
      finish: "stop",
      cost: 0,
      tokens: {
        input: 0,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  });

  expect(content.content).toBe("Session avg  50.0 tok/s\nGPT-5.4  50.0 tok/s");
});

test("uses the stream completion time for text-only history", () => {
  // The helper has no `streamed` field: write the message by hand.
  const textOnly = {
    id: "text-only",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5.4" },
    tokens: {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1000, completed: 5000, streamed: 2500 },
    content: [{ type: "text", text: "..." }],
  };
  const { content } = renderSidebar({ messages: [textOnly] });

  expect(content.content).toBe("Session avg  66.7 tok/s\nGPT-5.4  66.7 tok/s");
});

test("uses the reasoning end time to exclude tool waits", () => {
  // The reasoning window is anchored to the absolute message clock:
  // the sample must end at the reasoning end (8500), not at message
  // completion (9000), which would include the tool wait that follows.
  const reasoned = assistantMessage("reasoned", 100, 9000);
  reasoned.content.push({
    type: "reasoning",
    time: { created: 8000, completed: 8500 },
  });
  const { content } = renderSidebar({ messages: [reasoned] });

  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );
});

test("counts streamed text after reasoning but excludes the tool wait that follows", () => {
  // Reasoning ends at 8500, streamed text continues until 8700, and the
  // tool runs until completed=9500 (wait, excluded — same as the live
  // path). The correct duration is 8700-8000 = 700 ms.
  const reasonedStreamed = {
    id: "reasoned-streamed",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5.4" },
    tokens: {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 8000, streamed: 8700, completed: 9500 },
    content: [{ type: "reasoning", time: { created: 8000, completed: 8500 } }],
  };
  const { content } = renderSidebar({ messages: [reasonedStreamed] });

  expect(content.content).toBe(
    "Session avg  142.9 tok/s\nGPT-5.4  142.9 tok/s",
  );
});

test("drops history whose end precedes the message start", () => {
  // Malformed window (end < start). The engine already discards
  // non-positive durations; this test pins it as a historical-path rule.
  const malformed = {
    id: "malformed",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5.4" },
    tokens: {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 9000, streamed: 8500 },
    content: [],
  };
  const { content } = renderSidebar({ messages: [malformed] });

  expect(content.content).toBe("Waiting for completed output");
});

test("omits historical pure tool-call steps", () => {
  // Upstream contract: "omit historical pure tool-call steps" — a message
  // whose content is only tool parts has no text/reasoning output evidence.
  const toolOnly = {
    id: "tool-only",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5.4" },
    tokens: {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1000, completed: 3000 },
    content: [{ type: "tool", tool: "shell", time: { completed: 3000 } }],
  };
  const { content } = renderSidebar({ messages: [toolOnly] });

  expect(content.content).toBe("Waiting for completed output");
});

test("respects persisted reverts and adapts their lifecycle events", () => {
  const messages: TestMessage[] = [
    { id: "user-one", sessionID: "session", type: "user" },
    assistantMessage("assistant-one", 100, 2000),
    { id: "user-two", sessionID: "session", type: "user" },
    assistantMessage("assistant-two", 300, 4000),
  ];
  const { content, handlers } = renderSidebar({
    messages,
    revertedMessageID: "user-two",
  });

  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );
  handlers.get("session.revert.cleared")?.({
    data: { sessionID: "session" },
  });
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  handlers.get("session.revert.staged")?.({
    data: { sessionID: "session", revert: { messageID: "user-two" } },
  });
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );

  handlers.get("session.revert.cleared")?.({
    data: { sessionID: "session" },
  });
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  handlers.get("session.revert.committed")?.({
    data: { sessionID: "session", to: "user-two" },
  });
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );
});
