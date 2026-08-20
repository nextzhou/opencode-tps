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
  test("uses token-weighted generation time for the session and each model", () => {
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
  test("excludes tool wait between model steps", () => {
    const tracker = new SessionTpsTracker();
    tracker.startStep({
      sessionID: "session",
      messageID: "one",
      model: modelA,
    });
    tracker.observeOutput({
      sessionID: "session",
      messageID: "one",
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
      outputTokens: 60,
      reasoningTokens: 40,
      completedAt: 10_000,
    });

    // The ten-second gap represents tool execution and is not observed.
    tracker.startStep({
      sessionID: "session",
      messageID: "two",
      model: modelA,
    });
    tracker.observeOutput({
      sessionID: "session",
      messageID: "two",
      timestamp: 12_000,
    });
    tracker.finishOutput({
      sessionID: "session",
      messageID: "two",
      timestamp: 14_000,
    });
    tracker.completeStep({
      sessionID: "session",
      messageID: "two",
      outputTokens: 150,
      reasoningTokens: 50,
      completedAt: 20_000,
    });

    const summary = tracker.summary("session");
    expect(summary.total.tokens).toBe(300);
    expect(summary.total.durationMs).toBe(3000);
    expect(summary.total.tps).toBe(100);
  });

  test("keeps switched models separate", () => {
    const tracker = new SessionTpsTracker();
    for (const [messageID, model] of [
      ["one", modelA],
      ["two", modelB],
    ] as const) {
      tracker.startStep({ sessionID: "session", messageID, model });
      tracker.observeOutput({
        sessionID: "session",
        messageID,
        timestamp: 1000,
      });
      tracker.finishOutput({
        sessionID: "session",
        messageID,
        timestamp: 2000,
      });
      tracker.completeStep({
        sessionID: "session",
        messageID,
        outputTokens: 100,
        reasoningTokens: 0,
        completedAt: model === modelA ? 1 : 2,
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
    });
    tracker.observeOutput({
      sessionID: "session",
      messageID: "one",
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
      completedAt: 2,
    });

    const summary = tracker.summary("session", [
      sample("one", modelA, 10, 1000, 1),
    ]);
    expect(summary.total.tokens).toBe(100);
    expect(summary.total.samples).toBe(1);
  });

  test("temporarily excludes precise samples outside a reverted range", () => {
    const tracker = new SessionTpsTracker();
    for (const messageID of ["visible", "reverted"]) {
      tracker.startStep({ sessionID: "session", messageID, model: modelA });
      tracker.observeOutput({
        sessionID: "session",
        messageID,
        timestamp: 1000,
      });
      tracker.finishOutput({
        sessionID: "session",
        messageID,
        timestamp: 2000,
      });
      tracker.completeStep({
        sessionID: "session",
        messageID,
        outputTokens: 100,
        reasoningTokens: 0,
        completedAt: messageID === "visible" ? 1 : 2,
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
