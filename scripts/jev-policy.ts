import { COIN_TYPES } from "../src/contracts";
import type {
  CombatSolverPolicy,
  CombatSolverState,
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

export interface JevPolicyOptions {
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

function copyCombatCounts(
  counts: Record<(typeof COIN_TYPES)[number], number>,
): Record<(typeof COIN_TYPES)[number], number> {
  return Object.fromEntries(
    COIN_TYPES.map((type) => [type, counts[type]]),
  ) as Record<(typeof COIN_TYPES)[number], number>;
}

function serializeCombatState(state: CombatSolverState): string {
  const { observation } = state;
  return `Combat state uses the conservative ${observation.visibilityModel} readable projection only. x increases left-to-right; z increases forward toward the collection edge. A null feed slot is hidden or unreadable; do not infer its type. Choose survival and defeating the front enemy before remaining HP and currency. Rules give effective coin values before the simulation-timed sword combo. Gold gives 1 currency and diamonds give 10. Each physical bomb detonation deals ${observation.rules.bombDamage} HP to each side; zero HP damage does not disable the physical blast.
${JSON.stringify({
    visibilityModel: observation.visibilityModel,
    board: observableBoard(observation.board),
    playerHp: observation.playerHp,
    playerMaxHp: observation.playerMaxHp,
    enemies: observation.enemies,
    frontEnemyId: observation.frontEnemyId,
    waveIndex: observation.waveIndex,
    waveCount: observation.waveCount,
    livingWaveHp: observation.livingWaveHp,
    currency: observation.currency,
    ownedBuild: observation.ownedBuild,
    combo: observation.combo,
    rules: {
      swordDamage: observation.rules.swordDamage,
      skullDamage: observation.rules.skullDamage,
      potionHealing: observation.rules.potionHealing,
      bombDamage: observation.rules.bombDamage,
      bomb: {
        hitThreshold: observation.rules.bomb.hitThreshold,
        minClosingSpeed: observation.rules.bomb.minClosingSpeed,
        blastRadius: observation.rules.bomb.blastRadius,
        blastDeltaSpeed: observation.rules.bomb.blastDeltaSpeed,
      },
    },
    candidates: observation.candidates.map((candidate) => ({
      aimX: candidate.aimX,
      chutes: candidate.chutes.map((chute) => ({
        id: chute.id,
        ownerId: chute.ownerId,
        slot: chute.slot,
        enabled: chute.enabled,
        x: chute.x,
        source: chute.source,
      })),
    })),
    feed: observation.feed.map((tray) => ({
      id: tray.id,
      ownerId: tray.ownerId,
      slot: tray.slot,
      enabled: tray.enabled,
      x: tray.x,
      source: tray.source,
      preview: tray.preview,
    })),
    exposedCoins: observation.exposedCoins.map((coin) => ({
      type: coin.type,
      position: { x: coin.position.x, y: coin.position.y, z: coin.position.z },
      bombHits: coin.bombHits,
      nearThreshold: coin.nearThreshold,
    })),
    lanes: observation.lanes.map((lane) => ({
      index: lane.index,
      upper: {
        counts: copyCombatCounts(lane.upper.counts),
        nearThresholdBombs: lane.upper.nearThresholdBombs,
      },
      lowerRear: {
        counts: copyCombatCounts(lane.lowerRear.counts),
        nearThresholdBombs: lane.lowerRear.nearThresholdBombs,
      },
      lowerMiddle: {
        counts: copyCombatCounts(lane.lowerMiddle.counts),
        nearThresholdBombs: lane.lowerMiddle.nearThresholdBombs,
      },
      lowerFront: {
        counts: copyCombatCounts(lane.lowerFront.counts),
        nearThresholdBombs: lane.lowerFront.nearThresholdBombs,
      },
      nearEdge: {
        counts: copyCombatCounts(lane.nearEdge.counts),
        nearThresholdBombs: lane.nearEdge.nearThresholdBombs,
      },
    })),
    recentEffects: observation.recentEffects.map((batch) => ({
      delta: {
        swordDamage: batch.delta.swordDamage,
        skullDamage: batch.delta.skullDamage,
        bombDamageToEnemy: batch.delta.bombDamageToEnemy,
        bombDamageToPlayer: batch.delta.bombDamageToPlayer,
        enemyHpRemoved: batch.delta.enemyHpRemoved,
        healingOffered: batch.delta.healingOffered,
        healingUsed: batch.delta.healingUsed,
        healingWasted: batch.delta.healingWasted,
        currencyGained: batch.delta.currencyGained,
        safeBombs: batch.delta.safeBombs,
        detonations: batch.delta.detonations,
        blastAssociatedDetonations: batch.delta.blastAssociatedDetonations,
      },
      effects: batch.effects.map((effect) => ({
        type: effect.type,
        position: {
          x: effect.position.x,
          y: effect.position.y,
          z: effect.position.z,
        },
        enemyDamage: effect.enemyDamage,
        swordMultiplier: effect.swordMultiplier,
        playerDamage: effect.playerDamage,
        healingOffered: effect.healingOffered,
        currency: effect.currency,
        safeBomb: effect.safeBomb,
        detonated: effect.detonated,
        blastAssociated: effect.blastAssociated,
      })),
    })),
    candidateAimXs: [...state.candidateAimXs],
    timing: state.timing,
  })}`;
}

function combatActionCriteria(
  state: CombatSolverState,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    ACTION_CHOICES.map(({ key, action }) => {
      const candidate = state.observation.candidates[action.lane];
      if (!candidate)
        throw new Error(`Missing combat candidate for lane ${action.lane}`);
      const positions = candidate.chutes
        .map((chute) => `${chute.source} x=${chute.x}`)
        .join(", ");
      const waitMeaning =
        action.waitQuarters === 0
          ? "release now"
          : `wait ${action.waitQuarters} quarter-cycle${action.waitQuarters === 1 ? "" : "s"}`;
      return [
        key,
        `Choose candidate ${action.lane}, player aim x=${candidate.aimX}; ${waitMeaning}, then release synchronized chutes ${positions}.`,
      ];
    }),
  );
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
    responseChoice: answer.choice,
    model: response.model,
    inputTokens,
    outputTokens,
  };
}

interface JevRequest {
  state: string;
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}

function createJevRequestRunner(
  options: JevPolicyOptions,
): (request: JevRequest) => Promise<SolverDecision> {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0)
    throw new Error("Jev maxRequests must be a positive safe integer");

  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey || apiKey.trim().length === 0)
    throw new Error("TYPESAFE_API_KEY is required for the Jev policy");

  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  let requests = 0;

  return async ({ state, instructions, criteria }): Promise<SolverDecision> => {
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
            state,
            questions: {
              action: {
                type: "choice",
                instructions,
                criteria,
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

export function createJevPolicy(options: JevPolicyOptions): SolverPolicy {
  const request = createJevRequestRunner(options);
  return (state) =>
    request({
      state: serializeState(state),
      instructions: ACTION_INSTRUCTIONS,
      criteria: actionCriteria(state),
    });
}

export function createCombatJevPolicy(
  options: JevPolicyOptions,
): CombatSolverPolicy {
  const request = createJevRequestRunner(options);

  return (state) => {
    const timing = state.timing;
    const instructions =
      "Choose a synchronized combat release to preserve player survival and defeat the enemy, then prefer remaining health and currency. Swords damage the enemy, skulls damage the player, potions heal, gold gives 1 currency, diamonds give 10, and each bomb detonation deals exactly 5 damage to both combatants. " +
      (timing === "fixed"
        ? "Evaluate all 20 alternatives, but only placement is executed: every selected action executes with zero wait."
        : "Choose both placement and quarter-cycle timing.");
    return request({
      state: serializeCombatState(state),
      instructions,
      criteria: combatActionCriteria(state),
    });
  };
}
