import type {
  LaneBoard,
  SolverAction,
  SolverDecision,
  SolverPolicy,
  SolverState,
  SurfaceCell,
} from "../src/experiments/solver-contracts";
import { SOLVER_LANE_CENTERS } from "../src/experiments/solver-contracts";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const REQUEST_TIMEOUT_MS = 10_000;
const PROBABILITY_SUM_TOLERANCE = 0.02;
const WAITS = [0, 1, 2, 3] as const;

interface JevPolicyOptions {
  apiKey?: string;
  model?: string;
  maxRequests: number;
  fetchImpl?: typeof fetch;
}

interface ActionChoice {
  key: string;
  action: SolverAction;
}

const ACTION_CHOICES: readonly ActionChoice[] = SOLVER_LANE_CENTERS.flatMap(
  (_, lane) =>
    WAITS.map((waitQuarters) => ({
      key: `lane${lane}_wait${waitQuarters}`,
      action: { lane, waitQuarters },
    })),
);

const ACTION_BY_KEY: Readonly<Record<string, SolverAction>> =
  Object.fromEntries(ACTION_CHOICES.map(({ key, action }) => [key, action]));

function actionCriteria(state: SolverState): Readonly<Record<string, string>> {
  const aims = state.candidateAimXs ?? SOLVER_LANE_CENTERS;
  return Object.fromEntries(
    ACTION_CHOICES.map(({ key, action }) => {
      const center = aims[action.lane]!;
      const positions =
        state.pattern === "flanks"
          ? [
              center - (state.spacing ?? 0),
              center,
              center + (state.spacing ?? 0),
            ]
          : [center];
      const waitMeaning =
        action.waitQuarters === 0
          ? "release now"
          : `wait ${action.waitQuarters} quarter-cycle${action.waitQuarters === 1 ? "" : "s"}`;
      return [
        key,
        `Choose candidate ${action.lane}, center x=${center}; ${waitMeaning}, then release at chute position${positions.length === 1 ? "" : "s"} ${positions.join(", ")}.`,
      ];
    }),
  );
}

const ACTION_INSTRUCTIONS =
  "Choose where and when to release this nonoverlapping batch. Target >=90% " +
  "of releases producing >=1 real payout within one full pusher period from " +
  "first drop; favor dense connected paths and likely physical contact.";

const STATE_GUIDE =
  "Observed physical state only. x increases left-to-right; z increases " +
  "forward toward payout; y is up. Five equal lanes span x=-5..5, centered " +
  "at -4,-2,0,2,4. upper is the moving pusher top; lowerRear, lowerMiddle, " +
  "and lowerFront are fixed shelf bands ordered toward the payout edge. " +
  "Cell counts approximate contacts; meanHeight is y and meanForwardSpeed " +
  "is +z speed. pusherFront and shelfFront are +z front coordinates; " +
  "nearEdge counts coins by shelfFront and smaller edgeGap is nearer payout. " +
  "active counts actionable classified bodies; airborne and falling are excluded counts. " +
  "recentCollected is observed lane payout count in sampleSeconds. phase 0 is " +
  "fully retracted; phase 0.5 is fully extended. Normal chute coins land on the " +
  "upper pusher before reaching the lower shelf; back-row feed bypasses that travel. " +
  "Deliberate waiting payouts do not count toward release success. Coins and payouts are physical and " +
  "mass-conserved. A payout can be delayed and is not guaranteed causal " +
  "credit for the latest release.";

function copyCell(cell: SurfaceCell): SurfaceCell {
  return {
    count: cell.count,
    meanHeight: cell.meanHeight,
    meanForwardSpeed: cell.meanForwardSpeed,
  };
}

function observableBoard(board: LaneBoard): LaneBoard {
  return {
    time: board.time,
    sampleSeconds: board.sampleSeconds,
    phase: board.phase,
    period: board.period,
    pusherFront: board.pusherFront,
    shelfFront: board.shelfFront,
    active: board.active,
    airborne: board.airborne,
    falling: board.falling,
    lanes: board.lanes.map((lane) => ({
      index: lane.index,
      aimX: lane.aimX,
      upper: copyCell(lane.upper),
      lowerRear: copyCell(lane.lowerRear),
      lowerMiddle: copyCell(lane.lowerMiddle),
      lowerFront: copyCell(lane.lowerFront),
      nearEdge: lane.nearEdge,
      edgeGap: lane.edgeGap,
      recentCollected: lane.recentCollected,
    })),
  };
}

function serializeState(state: SolverState): string {
  const recent = state.recent.slice(-6).map((release) => ({
    action: {
      lane: release.action.lane,
      waitQuarters: release.action.waitQuarters,
    },
    coins: release.coins,
    collected: release.collected,
  }));

  return `${STATE_GUIDE}\n${JSON.stringify({
    board: observableBoard(state.board),
    release: {
      playerCoins: state.releaseCoins,
      feed: state.feed,
      pattern: state.pattern ?? "sequential",
      candidateCenterXs: state.candidateAimXs ?? SOLVER_LANE_CENTERS,
      flankCoins: state.enemyCoins ?? 0,
      spacing: state.spacing ?? 0,
    },
    recent,
  })}`;
}

interface JevResponse {
  model?: unknown;
  answers?: unknown;
  usage?: unknown;
}

interface JevAnswers {
  action?: unknown;
}

interface JevActionAnswer {
  type?: unknown;
  choice?: unknown;
  probabilities?: unknown;
}

function readTokenCount(
  usage: Record<string, unknown>,
  key: "input_tokens" | "output_tokens",
): number {
  const value = usage[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(
      `Invalid Jev response: ${key} must be a nonnegative integer`,
    );
  return value as number;
}

function parseDecision(payload: unknown): SolverDecision {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new Error("Invalid Jev response: expected an object");
  const response = payload as JevResponse;
  if (typeof response.model !== "string" || response.model.length === 0)
    throw new Error("Invalid Jev response: missing model");

  if (
    typeof response.answers !== "object" ||
    response.answers === null ||
    Array.isArray(response.answers)
  )
    throw new Error("Invalid Jev response: missing answers");
  const answers = response.answers as JevAnswers;
  const answerKeys = Object.keys(response.answers);
  if (answerKeys.length !== 1 || answerKeys[0] !== "action")
    throw new Error("Invalid Jev response: unexpected answer fields");

  if (
    typeof answers.action !== "object" ||
    answers.action === null ||
    Array.isArray(answers.action)
  )
    throw new Error("Invalid Jev response: malformed action answer");
  const answer = answers.action as JevActionAnswer;
  if (answer.type !== "choice")
    throw new Error("Invalid Jev response: malformed action answer");
  if (
    typeof answer.choice !== "string" ||
    !Object.hasOwn(ACTION_BY_KEY, answer.choice)
  )
    throw new Error("Invalid Jev response: malformed action choice");

  if (
    typeof answer.probabilities !== "object" ||
    answer.probabilities === null ||
    Array.isArray(answer.probabilities)
  )
    throw new Error("Invalid Jev response: missing action probabilities");
  const probabilities = answer.probabilities as Record<string, unknown>;
  const probabilityKeys = Object.keys(probabilities);
  if (
    probabilityKeys.length !== ACTION_CHOICES.length ||
    probabilityKeys.some((key) => !Object.hasOwn(ACTION_BY_KEY, key))
  )
    throw new Error("Invalid Jev response: action alternatives do not match");

  const parsedProbabilities: Record<string, number> = {};
  let sum = 0;
  let selected = ACTION_CHOICES[0]!;
  let highest = -1;
  for (const choice of ACTION_CHOICES) {
    const probability = probabilities[choice.key];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    )
      throw new Error(
        `Invalid Jev response: invalid probability for ${choice.key}`,
      );
    parsedProbabilities[choice.key] = probability;
    sum += probability;
    if (probability > highest) {
      highest = probability;
      selected = choice;
    }
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE)
    throw new Error("Invalid Jev response: probabilities do not sum to one");

  if (
    typeof response.usage !== "object" ||
    response.usage === null ||
    Array.isArray(response.usage)
  )
    throw new Error("Invalid Jev response: missing usage");
  const usage = response.usage as Record<string, unknown>;
  const inputTokens = readTokenCount(usage, "input_tokens");
  const outputTokens = readTokenCount(usage, "output_tokens");

  return {
    action: { ...selected.action },
    probabilities: parsedProbabilities,
    model: response.model,
    inputTokens,
    outputTokens,
  };
}

export function createJevPolicy(options: JevPolicyOptions): SolverPolicy {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0)
    throw new Error("Jev maxRequests must be a positive safe integer");

  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey || apiKey.trim().length === 0)
    throw new Error("TYPESAFE_API_KEY is required for the Jev policy");

  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  let requests = 0;

  return async (state): Promise<SolverDecision> => {
    if (requests >= options.maxRequests)
      throw new Error(`Jev request budget exhausted (${options.maxRequests})`);
    requests += 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetchImpl(TYPESAFE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            state: serializeState(state),
            questions: {
              action: {
                type: "choice",
                instructions: ACTION_INSTRUCTIONS,
                criteria: actionCriteria(state),
              },
            },
          }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted)
          throw new Error(
            `Jev request timed out after ${REQUEST_TIMEOUT_MS} milliseconds`,
          );
        throw new Error("Jev network request failed");
      }

      if (!response.ok)
        throw new Error(`Jev request failed with HTTP ${response.status}`);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted)
          throw new Error(
            `Jev request timed out after ${REQUEST_TIMEOUT_MS} milliseconds`,
          );
        throw new Error("Invalid Jev response: body is not JSON");
      }
      return parseDecision(payload);
    } finally {
      clearTimeout(timeout);
    }
  };
}
