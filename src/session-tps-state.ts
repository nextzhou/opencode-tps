export type ModelIdentity = {
  providerID: string;
  id: string;
  variant?: string;
};

export type TpsSample = {
  messageID: string;
  model: ModelIdentity;
  tokens: number;
  durationMs: number;
  completedAt: number;
};

export type TpsMetric = {
  tokens: number;
  durationMs: number;
  tps: number;
  samples: number;
  lastCompletedAt: number;
};

export type ModelTpsMetric = TpsMetric & {
  model: ModelIdentity;
};

export type SessionTpsSummary = {
  total: TpsMetric;
  byModel: ModelTpsMetric[];
};

type ActiveStep = {
  sessionID: string;
  model?: ModelIdentity;
  requestStartedAt: number;
  outputEndedAt?: number;
};

type StepRef = {
  sessionID: string;
  messageID: string;
};

function modelKey(model: ModelIdentity): string {
  return `${model.providerID}\u0000${model.id}\u0000${model.variant ?? ""}`;
}

function emptyMetric(): TpsMetric {
  return {
    tokens: 0,
    durationMs: 0,
    tps: 0,
    samples: 0,
    lastCompletedAt: 0,
  };
}

function addSample(metric: TpsMetric, sample: TpsSample): void {
  metric.tokens += sample.tokens;
  metric.durationMs += sample.durationMs;
  metric.samples += 1;
  metric.lastCompletedAt = Math.max(metric.lastCompletedAt, sample.completedAt);
  metric.tps = (metric.tokens * 1000) / metric.durationMs;
}

export function summarizeTps(samples: Iterable<TpsSample>): SessionTpsSummary {
  const latestByMessage = new Map<string, TpsSample>();
  for (const sample of samples) {
    if (
      sample.tokens <= 0 ||
      sample.durationMs <= 0 ||
      !Number.isFinite(sample.tokens) ||
      !Number.isFinite(sample.durationMs)
    ) {
      continue;
    }
    latestByMessage.set(sample.messageID, sample);
  }

  const total = emptyMetric();
  const byModel = new Map<string, ModelTpsMetric>();
  for (const sample of latestByMessage.values()) {
    addSample(total, sample);

    const key = modelKey(sample.model);
    const metric = byModel.get(key) ?? {
      ...emptyMetric(),
      model: sample.model,
    };
    addSample(metric, sample);
    byModel.set(key, metric);
  }

  return {
    total,
    byModel: Array.from(byModel.values()).sort(
      (left, right) => right.lastCompletedAt - left.lastCompletedAt,
    ),
  };
}

export class SessionTpsTracker {
  private readonly active = new Map<string, ActiveStep>();
  private readonly completed = new Map<string, Map<string, TpsSample>>();

  startStep(
    input: StepRef & { model: ModelIdentity; timestamp: number },
  ): void {
    if (!Number.isFinite(input.timestamp)) return;

    this.active.set(input.messageID, {
      sessionID: input.sessionID,
      model: input.model,
      requestStartedAt: input.timestamp,
    });
  }

  finishOutput(input: StepRef & { timestamp: number }): void {
    const step = this.active.get(input.messageID);
    if (!step || !Number.isFinite(input.timestamp)) return;

    step.outputEndedAt = Math.max(
      step.outputEndedAt ?? input.timestamp,
      input.timestamp,
    );
  }

  completeStep(
    input: StepRef & {
      model?: ModelIdentity;
      outputTokens: number;
      reasoningTokens: number;
    },
  ): TpsSample | undefined {
    const step = this.active.get(input.messageID);
    this.active.delete(input.messageID);

    const model = step?.model ?? input.model;
    const requestStartedAt = step?.requestStartedAt;
    const outputEndedAt = step?.outputEndedAt;
    const tokens = input.outputTokens + input.reasoningTokens;
    if (
      !model ||
      requestStartedAt === undefined ||
      outputEndedAt === undefined ||
      outputEndedAt <= requestStartedAt ||
      tokens <= 0 ||
      !Number.isFinite(tokens)
    ) {
      return;
    }

    const sample: TpsSample = {
      messageID: input.messageID,
      model,
      tokens,
      durationMs: outputEndedAt - requestStartedAt,
      completedAt: outputEndedAt,
    };
    const session = this.completed.get(input.sessionID) ?? new Map();
    session.set(input.messageID, sample);
    this.completed.set(input.sessionID, session);
    return sample;
  }

  failStep(messageID: string): void {
    this.active.delete(messageID);
  }

  removeMessage(sessionID: string, messageID: string): void {
    this.active.delete(messageID);
    this.completed.get(sessionID)?.delete(messageID);
  }

  summary(
    sessionID: string,
    historicalSamples: Iterable<TpsSample> = [],
    includedMessageIDs?: ReadonlySet<string>,
  ): SessionTpsSummary {
    const completedSamples = this.completed.get(sessionID)?.values() ?? [];
    return summarizeTps([
      ...historicalSamples,
      ...Array.from(completedSamples).filter(
        (sample) =>
          !includedMessageIDs || includedMessageIDs.has(sample.messageID),
      ),
    ]);
  }
}
