import { describe, expect, test } from "bun:test";
import {
  SessionTpsTracker,
  summarizeTps,
  type ModelIdentity,
  type TpsSample,
} from "../src/session-tps-state.js";

const modelA: ModelIdentity = {
  providerID: "provider-a",
  id: "model-a",
  variant: "fast",
};
const modelB: ModelIdentity = {
  providerID: "provider-b",
  id: "model-b",
};

function sample(
  messageID: string,
  model: ModelIdentity,
  tokens: number,
  durationMs: number,
  completedAt: number,
): TpsSample {
  return { messageID, model, tokens, durationMs, completedAt };
}

describe("summarizeTps", () => {
  test("uses token-weighted request time for the session and each model", () => {
    const summary = summarizeTps([
      sample("one", modelA, 100, 1000, 1),
      sample("two", modelA, 300, 3000, 2),
      sample("three", modelB, 100, 500, 3),
    ]);

    expect(summary.total.tokens).toBe(500);
    expect(summary.total.durationMs).toBe(4500);
    expect(summary.total.tps).toBeCloseTo(111.11, 2);
    expect(summary.byModel).toHaveLength(2);
    expect(summary.byModel[0]).toMatchObject({ model: modelB, tps: 200 });
    expect(summary.byModel[1]).toMatchObject({ model: modelA, tps: 100 });
  });

  test("ignores invalid samples", () => {
    const summary = summarizeTps([
      sample("zero-duration", modelA, 100, 0, 1),
      sample("zero-tokens", modelA, 0, 1000, 2),
    ]);

    expect(summary.total.samples).toBe(0);
    expect(summary.byModel).toEqual([]);
  });
});

describe("SessionTpsTracker", () => {
  test("includes request startup and excludes tool execution", () => {
    const tracker = new SessionTpsTracker();
    tracker.startStep({
      sessionID: "session",
      messageID: "one",
      model: modelA,
      timestamp: 1000,
    });
    tracker.finishOutput({
      sessionID: "session",
      messageID: "one",
      timestamp: 3000,
    });

    // Completion occurs after tool execution, but only the output end is used.
    tracker.completeStep({
      sessionID: "session",
      messageID: "one",
      outputTokens: 60,
      reasoningTokens: 40,
    });

    tracker.startStep({
      sessionID: "session",
      messageID: "two",
      model: modelA,
      timestamp: 12_000,
    });
    tracker.finishOutput({
      sessionID: "session",
      messageID: "two",
      timestamp: 16_000,
    });
    tracker.completeStep({
      sessionID: "session",
      messageID: "two",
      outputTokens: 150,
      reasoningTokens: 50,
    });

    const summary = tracker.summary("session");
    expect(summary.total.tokens).toBe(300);
    expect(summary.total.durationMs).toBe(6000);
    expect(summary.total.tps).toBe(50);
  });

  test("keeps switched models separate", () => {
    const tracker = new SessionTpsTracker();
    for (const [messageID, model, timestamp] of [
      ["one", modelA, 1000],
      ["two", modelB, 3000],
    ] as const) {
      tracker.startStep({ sessionID: "session", messageID, model, timestamp });
      tracker.finishOutput({
        sessionID: "session",
        messageID,
        timestamp: timestamp + 1000,
      });
      tracker.completeStep({
        sessionID: "session",
        messageID,
        outputTokens: 100,
        reasoningTokens: 0,
      });
    }

    const summary = tracker.summary("session");
    expect(summary.byModel.map((metric) => metric.model)).toEqual([
      modelB,
      modelA,
    ]);
  });

  test("replaces historical estimates with precise event samples", () => {
    const tracker = new SessionTpsTracker();
    tracker.startStep({
      sessionID: "session",
      messageID: "one",
      model: modelA,
      timestamp: 1000,
    });
    tracker.finishOutput({
      sessionID: "session",
      messageID: "one",
      timestamp: 2000,
    });
    tracker.completeStep({
      sessionID: "session",
      messageID: "one",
      outputTokens: 75,
      reasoningTokens: 25,
    });

    const summary = tracker.summary("session", [
      sample("one", modelA, 10, 1000, 1),
    ]);
    expect(summary.total.tokens).toBe(100);
    expect(summary.total.samples).toBe(1);
  });

  test("temporarily excludes precise samples outside a reverted range", () => {
    const tracker = new SessionTpsTracker();
    for (const [messageID, timestamp] of [
      ["visible", 1000],
      ["reverted", 3000],
    ] as const) {
      tracker.startStep({
        sessionID: "session",
        messageID,
        model: modelA,
        timestamp,
      });
      tracker.finishOutput({
        sessionID: "session",
        messageID,
        timestamp: timestamp + 1000,
      });
      tracker.completeStep({
        sessionID: "session",
        messageID,
        outputTokens: 100,
        reasoningTokens: 0,
      });
    }

    const reverted = tracker.summary("session", [], new Set(["visible"]));
    expect(reverted.total.tokens).toBe(100);
    expect(reverted.total.samples).toBe(1);

    const restored = tracker.summary("session");
    expect(restored.total.tokens).toBe(200);
    expect(restored.total.samples).toBe(2);
  });
});
