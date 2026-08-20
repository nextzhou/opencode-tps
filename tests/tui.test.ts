import { expect, mock, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

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

const { default: plugin } = await import("../src/tui.js");

type EventHandler = (event: { properties: Record<string, unknown> }) => void;
type TestMessage =
  | ReturnType<typeof assistantMessage>
  | {
      id: string;
      sessionID: string;
      role: "user";
    };

function assistantMessage(id: string, tokens: number, completed: number) {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    providerID: "openai",
    modelID: "gpt-5.4",
    mode: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: {
      input: 0,
      output: tokens,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: completed - 1000, completed },
  };
}

async function renderSidebar(input: {
  messages: TestMessage[];
  parts?: Map<string, Record<string, unknown>[]>;
  revertedMessageID?: string;
}) {
  const handlers = new Map<string, EventHandler>();
  let sidebarContent:
    | ((context: unknown, props: unknown) => unknown)
    | undefined;
  const api = {
    renderer: {},
    state: {
      provider: [
        {
          id: "openai",
          name: "OpenAI",
          models: { "gpt-5.4": { name: "GPT-5.4" } },
        },
      ],
      session: {
        get: () =>
          input.revertedMessageID
            ? { revert: { messageID: input.revertedMessageID } }
            : undefined,
        messages: () => input.messages,
      },
      part: (messageID: string) => input.parts?.get(messageID) ?? [],
    },
    slots: {
      register: (registration: {
        slots: { sidebar_content: typeof sidebarContent };
      }) => {
        sidebarContent = registration.slots.sidebar_content;
      },
    },
    event: {
      on: (name: string, handler: EventHandler) => {
        handlers.set(name, handler);
      },
    },
  } as unknown as TuiPluginApi;

  await plugin.tui(api, undefined, {} as never);
  const container = sidebarContent?.(
    { theme: { current: { text: "white", textMuted: "gray" } } },
    { session_id: "session" },
  ) as FakeBoxRenderable;
  const content = container.children[1];
  if (!content) throw new Error("sidebar content was not rendered");
  return { content, handlers };
}

test("measures from request start to output end", async () => {
  const messages = [assistantMessage("assistant-live", 100, 9000)];
  const { content, handlers } = await renderSidebar({ messages });

  expect(content.content).toBe("Waiting for completed output");
  handlers.get("session.next.step.started")?.({
    properties: {
      timestamp: 1000,
      sessionID: "session",
      assistantMessageID: "assistant-live",
      model: { providerID: "openai", id: "gpt-5.4" },
    },
  });
  handlers.get("session.next.text.ended")?.({
    properties: {
      timestamp: 3000,
      sessionID: "session",
      assistantMessageID: "assistant-live",
    },
  });
  handlers.get("session.next.step.ended")?.({
    properties: {
      timestamp: 9000,
      sessionID: "session",
      assistantMessageID: "assistant-live",
      tokens: { output: 100, reasoning: 0 },
    },
  });

  expect(content.content).toBe("Session avg  50.0 tok/s\nGPT-5.4  50.0 tok/s");
});

test("respects persisted reverts and adapts their lifecycle events", async () => {
  const messages: TestMessage[] = [
    { id: "user-one", sessionID: "session", role: "user" },
    assistantMessage("assistant-one", 100, 2000),
    { id: "user-two", sessionID: "session", role: "user" },
    assistantMessage("assistant-two", 300, 4000),
  ];
  const parts = new Map([
    [
      "assistant-one",
      [
        {
          id: "part-one",
          sessionID: "session",
          messageID: "assistant-one",
          type: "text",
          text: "one",
          time: { start: 1000, end: 2000 },
        },
      ],
    ],
    [
      "assistant-two",
      [
        {
          id: "part-two",
          sessionID: "session",
          messageID: "assistant-two",
          type: "text",
          text: "two",
          time: { start: 2000, end: 4000 },
        },
      ],
    ],
  ]);
  const { content, handlers } = await renderSidebar({
    messages,
    parts,
    revertedMessageID: "user-two",
  });

  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );
  handlers.get("session.next.revert.cleared")?.({
    properties: { sessionID: "session" },
  });
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  handlers.get("session.next.revert.staged")?.({
    properties: {
      sessionID: "session",
      revert: { messageID: "user-two" },
    },
  });
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );

  handlers.get("session.next.revert.cleared")?.({
    properties: { sessionID: "session" },
  });
  expect(content.content).toBe(
    "Session avg  200.0 tok/s\nGPT-5.4  200.0 tok/s",
  );

  handlers.get("session.next.revert.committed")?.({
    properties: { sessionID: "session", messageID: "user-two" },
  });
  expect(content.content).toBe(
    "Session avg  100.0 tok/s\nGPT-5.4  100.0 tok/s",
  );
});
