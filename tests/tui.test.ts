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
  isDestroyed = false;
  writesAfterDestroy = 0;
  private text: string;

  constructor(_renderer: unknown, options: { content: string }) {
    this.text = options.content;
  }

  get content(): string {
    return this.text;
  }

  set content(value: string) {
    // Mock instrumentation: count writes to destroyed views, which the
    // refresh prune must prevent.
    if (this.isDestroyed) this.writesAfterDestroy += 1;
    this.text = value;
  }
}

mock.module("@opentui/core", () => ({
  BoxRenderable: FakeBoxRenderable,
  TextAttributes: { BOLD: 1 },
  TextRenderable: FakeTextRenderable,
}));

const { default: plugin } = (await import("../src/tui.js")) as unknown as {
  default: { setup: (ctx: unknown) => () => void };
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
  // Simulates the cold catalog: LocationCollection.list is Value[] | undefined.
  coldCatalog?: boolean;
  // Injectable catalog for model-name tests.
  models?: Record<string, unknown>[];
  providers?: Record<string, unknown>[];
}) {
  const handlers = new Map<string, EventHandler>();
  const claims: Record<string, unknown>[] = [];
  let slotDissolved = false;
  const modelList = () =>
    input.coldCatalog ? undefined : (input.models ?? [gptModel]);
  const providerList = () =>
    input.coldCatalog ? undefined : (input.providers ?? [openaiProvider]);
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
        message: {
          // The "other" session has no messages (multi-session view test).
          list: (id?: string) => (id === "other" ? [] : input.messages),
        },
      },
      location: {
        default: () => "loc",
        model: { list: modelList },
        provider: { list: providerList },
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
  return {
    content,
    handlers,
    claims,
    cleanup,
    isDissolved: () => slotDissolved,
  };
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

test("purges precise samples when a revert commits", () => {
  const messages: TestMessage[] = [assistantMessage("msg-a", 100, 2000)];
  const { content, handlers } = renderSidebar({ messages });

  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );

  messages.push(assistantMessage("msg-b", 300, 5000));
  handlers.get("session.step.started")?.({
    data: {
      sessionID: "session",
      assistantMessageID: "msg-b",
      model: { providerID: "openai", id: "gpt-5.4" },
      started: 3000,
    },
  });
  handlers.get("session.text.ended")?.({
    created: 4000,
    data: {
      sessionID: "session",
      assistantMessageID: "msg-b",
      ordinal: 0,
      text: "...",
    },
  });
  handlers.get("session.step.ended")?.({
    created: 5000,
    data: {
      sessionID: "session",
      assistantMessageID: "msg-b",
      finish: "stop",
      cost: 0,
      tokens: {
        input: 0,
        output: 300,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  });
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  messages.length = 1;
  // The revert commit is the only purge channel (`message.removed` does not
  // exist in V2, so nothing else fires here on purpose).
  handlers.get("session.revert.committed")?.({
    data: { sessionID: "session", to: "msg-b" },
  });
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );

  handlers.get("session.deleted")?.({ data: { sessionID: "session" } });
});

test("purges tracker samples when a session is deleted", () => {
  const messages: TestMessage[] = [assistantMessage("msg-live", 100)];
  const { content, handlers } = renderSidebar({ messages });

  handlers.get("session.step.started")?.({
    data: {
      sessionID: "session",
      assistantMessageID: "msg-live",
      model: { providerID: "openai", id: "gpt-5.4" },
      started: 1000,
    },
  });
  handlers.get("session.text.ended")?.({
    created: 2000,
    data: {
      sessionID: "session",
      assistantMessageID: "msg-live",
      ordinal: 0,
      text: "...",
    },
  });
  handlers.get("session.step.ended")?.({
    created: 3000,
    data: {
      sessionID: "session",
      assistantMessageID: "msg-live",
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
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );

  // The session is deleted: the host stops returning messages. A later
  // refresh must NOT revive the precise sample left in the tracker.
  messages.length = 0;
  handlers.get("session.deleted")?.({ data: { sessionID: "session" } });
  handlers.get("session.revert.cleared")?.({
    data: { sessionID: "session" },
  });
  expect(content.content).toBe("Waiting for completed output");
});

test("excludes an assistant boundary message itself (host deletes seq >= boundary)", () => {
  // The boundary is an ASSISTANT message — the case that discriminates the
  // off-by-one in `to` (a user boundary cannot: users contribute no
  // tokens). The host deletes seq >= boundary, so the limit itself does
  // not count.
  const messages: TestMessage[] = [
    { id: "user-one", sessionID: "session", type: "user" },
    assistantMessage("assistant-one", 100, 2000),
    assistantMessage("assistant-two", 300, 4000),
  ];
  const { content, handlers } = renderSidebar({ messages });

  // 400 tokens / 2000 ms = 200.0
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  handlers.get("session.revert.staged")?.({
    data: { sessionID: "session", revert: { messageID: "assistant-one" } },
  });
  // The boundary (assistant-one) stays out: no visible messages.
  expect(content.content).toBe("Waiting for completed output");

  handlers.get("session.revert.cleared")?.({
    data: { sessionID: "session" },
  });
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  handlers.get("session.revert.committed")?.({
    data: { sessionID: "session", to: "assistant-one" },
  });
  expect(content.content).toBe("Waiting for completed output");
});

test("renders even when the catalog cache is cold", () => {
  // The host boots with a cold catalog: model/provider list can be
  // undefined (LocationCollection.list => Value[] | undefined). The name
  // falls back to the model id, but the block must not throw.
  const messages = [assistantMessage("msg-a", 100, 2000)];
  const { content } = renderSidebar({ messages, coldCatalog: true });

  expect(content.content).toBe(
    "Session avg  100.0 tok/s\ngpt-5.4  100.0 tok/s",
  );
});

// A message reporting an explicit model variant (e.g. "default", "turbo").
function messageWithVariant(variant: string) {
  return {
    id: `msg-${variant}`,
    sessionID: "session",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5.4", variant },
    tokens: {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1000, completed: 3000 },
    content: [{ type: "text", text: "..." }],
  };
}

test("drops the default model variant suffix but keeps explicit variants", () => {
  // Local providers report variant "default": the literal V1 suffix
  // clutters the line ("GPT-5.4 Default"). Explicit variants are shown.
  const def = renderSidebar({ messages: [messageWithVariant("default")] });
  expect(def.content.content).toBe(
    "Session avg  50.0 tok/s\nGPT-5.4  50.0 tok/s",
  );

  const turbo = renderSidebar({ messages: [messageWithVariant("turbo")] });
  expect(turbo.content.content).toBe(
    "Session avg  50.0 tok/s\nGPT-5.4 Turbo  50.0 tok/s",
  );
});

test("disambiguates identical model names across providers", () => {
  // Two providers exposing the same model name -> "(Provider)" suffix.
  const messages: TestMessage[] = [
    {
      ...assistantMessage("m-openai", 100, 2000),
      model: { providerID: "openai", id: "gpt-5.4" },
    },
    {
      ...assistantMessage("m-anthropic", 100, 4000),
      model: { providerID: "anthropic", id: "gpt-5.4" },
    },
  ];
  const { content } = renderSidebar({
    messages,
    models: [
      {
        providerID: "openai",
        modelID: "gpt-5.4",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
      {
        providerID: "anthropic",
        modelID: "gpt-5.4",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
    ],
    providers: [
      { id: "openai", name: "OpenAI" },
      { id: "anthropic", name: "Anthropic" },
    ],
  });

  // Order by lastCompletedAt desc -> anthropic (4000) before openai (2000).
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\n" +
      "GPT-5.4 (Anthropic)  100.0 tok/s\n" +
      "GPT-5.4 (OpenAI)  100.0 tok/s",
  );
});

test("prunes destroyed views without writing to them", () => {
  // A destroyed view (screen/session change) must not receive writes, and
  // the live views must still update.
  const messages = [assistantMessage("msg-a", 100, 2000)];
  const { content, handlers, claims } = renderSidebar({ messages });
  const claim = claims.find((entry) => entry.append === "sidebar.content");
  if (!claim) throw new Error("sidebar.content claim was not registered");
  const render = claim.render as (props: {
    sessionID: string;
  }) => FakeBoxRenderable;
  const second = render({ sessionID: "session" }).children[1];
  if (!second) throw new Error("second sidebar view was not rendered");

  content.isDestroyed = true;
  messages.push(assistantMessage("msg-b", 300, 4000));
  handlers.get("session.revert.cleared")?.({ data: { sessionID: "session" } });

  expect(content.writesAfterDestroy).toBe(0);
  expect(second.content).toBe("Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s");
});

test("updates only the view whose session changed", () => {
  // A view for another session coexisting in the set: an event for
  // "session" must not touch the text of "other".
  const messages = [assistantMessage("msg-a", 100, 2000)];
  const { content, handlers, claims } = renderSidebar({ messages });
  const claim = claims.find((entry) => entry.append === "sidebar.content");
  if (!claim) throw new Error("sidebar.content claim was not registered");
  const render = claim.render as (props: {
    sessionID: string;
  }) => FakeBoxRenderable;
  const other = render({ sessionID: "other" }).children[1];
  if (!other) throw new Error("other-session view was not rendered");
  expect(other.content).toBe("Waiting for completed output");

  handlers.get("session.revert.cleared")?.({ data: { sessionID: "session" } });

  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );
  expect(other.content).toBe("Waiting for completed output");
});

test("returns a cleanup that unsubscribes events and dissolves the slot claim", () => {
  const { handlers, cleanup, isDissolved } = renderSidebar({ messages: [] });

  expect(isDissolved()).toBe(false);
  expect(handlers.size).toBeGreaterThan(0);
  cleanup();
  expect(handlers.size).toBe(0);
  expect(isDissolved()).toBe(true);
});
