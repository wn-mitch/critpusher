import { performance } from "node:perf_hooks";
import { COIN_TYPES, type SimulationStats, type Tuning } from "../src/contracts";
import { DEFAULT_CHUTES } from "../src/chutes";
import { createEncounter } from "../src/combat/encounter";
import type {
  CombatStepResult,
  CombatTotals,
  Encounter,
  EncounterConfig,
  EncounterSnapshot,
  EncounterStep,
  RoundAdmission,
} from "../src/combat/types";
import { createCombatObserver } from "../src/experiments/combat-observation";
import {
  chooseCombatCenterAction,
  chooseCombatRuleAction,
  createCombatRandomPolicy,
} from "../src/experiments/combat-policy";
import type {
  CombatSolverPolicy,
  SolverAction,
  SolverDecision,
} from "../src/experiments/solver-contracts";
import { DEFAULT_TUNING } from "../src/simulation/config";
import { planRain } from "../src/simulation/rain";
import { createCombatJevPolicy } from "./jev-policy";
import { validateAction } from "./release-trial";
import type {
  FightApiUsage,
  FightDecisionTrace,
  FightLedgerEntry,
  FightMetrics,
  FightRow,
  FightLoading,
  FightTrial,
  FightWindow,
  ReplayCheck,
  TypeCounts,
} from "./combat-contracts";
import {
  CYCLE_TICKS,
  FIXED_HZ,
  PhysicalEvidence,
  emptyTypeCounts,
  initialFightDigest,
  simulationFightDigest,
  stableFeed,
  stableFeedStreams,
} from "./combat-evidence";
import { canonicalJson, MECHANICAL_WAIT_LIMIT_TICKS, validateFightTrial } from "./combat-protocol";

const MIN_LOADING_TICKS = 720;
const MAX_LOADING_TICKS = 1440;
const QUARTER_CYCLE_TICKS = CYCLE_TICKS / 4;

type EncounterFactory = (
  tuning?: Partial<Tuning>,
  config?: Partial<EncounterConfig>,
) => Promise<Encounter>;

export interface CombatTrialOptions {
  replay?: FightRow;
  policy?: CombatSolverPolicy;
  encounterFactory?: EncounterFactory;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyDecision(decision: SolverDecision): SolverDecision {
  return {
    action: { ...decision.action },
    ...(decision.probabilities === undefined ? {} : { probabilities: { ...decision.probabilities } }),
    ...(decision.responseChoice === undefined ? {} : { responseChoice: decision.responseChoice }),
    ...(decision.model === undefined ? {} : { model: decision.model }),
    ...(decision.inputTokens === undefined ? {} : { inputTokens: decision.inputTokens }),
    ...(decision.outputTokens === undefined ? {} : { outputTokens: decision.outputTokens }),
  };
}

function copyAdmission(admission: RoundAdmission): RoundAdmission {
  return {
    ...admission,
    coins: admission.coins.map((coin) => ({ ...coin })),
  };
}

function validateDecision(decision: unknown): asserts decision is SolverDecision {
  if (typeof decision !== "object" || decision === null || Array.isArray(decision))
    throw new Error("Combat policy returned a malformed decision");
  const candidate = decision as Partial<SolverDecision>;
  if (typeof candidate.action !== "object" || candidate.action === null || Array.isArray(candidate.action))
    throw new Error("Combat policy returned a malformed action");
  validateAction(candidate.action);
  if (candidate.probabilities !== undefined) {
    if (typeof candidate.probabilities !== "object" || candidate.probabilities === null || Array.isArray(candidate.probabilities))
      throw new Error("Combat policy returned malformed probabilities");
    for (const probability of Object.values(candidate.probabilities)) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        throw new Error("Combat policy returned an invalid probability");
    }
  }
  for (const [label, value] of [["input", candidate.inputTokens], ["output", candidate.outputTokens]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error(`Combat policy returned invalid ${label} token usage`);
  }
  if (candidate.responseChoice !== undefined && typeof candidate.responseChoice !== "string")
    throw new Error("Combat policy returned an invalid response choice");
  if (candidate.model !== undefined && typeof candidate.model !== "string")
    throw new Error("Combat policy returned an invalid model identifier");
}

function createPolicy(trial: FightTrial): CombatSolverPolicy {
  if (trial.policy === "center") return chooseCombatCenterAction;
  if (trial.policy === "random") return createCombatRandomPolicy(trial.seed);
  if (trial.policy === "rule") return chooseCombatRuleAction;
  return createCombatJevPolicy({ maxRequests: trial.maxJevRequests });
}

function plannedStartingCounts(encounter: Encounter): TypeCounts {
  const counts = emptyTypeCounts();
  for (const drop of planRain(encounter.simulation.tuning, encounter.snapshot().config.openingMix))
    counts[drop.type] += 1;
  return counts;
}

function totalsNonzero(totals: CombatTotals): boolean {
  return (
    totals.swordDamage !== 0 ||
    totals.skullDamage !== 0 ||
    totals.bombDamageToEnemy !== 0 ||
    totals.bombDamageToPlayer !== 0 ||
    totals.enemyHpRemoved !== 0 ||
    totals.discardedDamage !== 0 ||
    totals.healingOffered !== 0 ||
    totals.healingUsed !== 0 ||
    totals.healingWasted !== 0 ||
    totals.currencyGained !== 0 ||
    totals.safeBombs !== 0 ||
    totals.detonations !== 0 ||
    totals.blastAssociatedDetonations !== 0
  );
}

function longestRun(windows: readonly FightWindow[], predicate: (window: FightWindow) => boolean): number {
  let current = 0;
  let longest = 0;
  for (const window of windows) {
    current = predicate(window) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function buildMetrics(
  final: EncounterSnapshot,
  windows: readonly FightWindow[],
  attemptedActions: number,
  decisionOpportunities: number,
  elapsedTicks: number,
  largestRollingIncoming: number,
  lostByType: TypeCounts,
): FightMetrics {
  return {
    acceptedActions: final.acceptedActions,
    attemptedActions,
    decisionOpportunities,
    elapsedTicks,
    elapsedSeconds: elapsedTicks / FIXED_HZ,
    finalTick: final.tick,
    terminalActionCount: final.result === null ? null : final.acceptedActions,
    terminalSeconds: final.result === null ? null : elapsedTicks / FIXED_HZ,
    longestDry: longestRun(windows, (window) => window.dry),
    longestNoEnemyDamage: longestRun(windows, (window) => window.noEnemyDamage),
    largestRollingIncoming,
    largestRollingIncomingFraction: largestRollingIncoming / final.playerMaxHp,
    severeBurst: largestRollingIncoming >= final.playerMaxHp * 0.25,
    lostByType: { ...lostByType },
  };
}

export function invalidFightRow(trial: FightTrial, error: string): FightRow {
  return {
    trial,
    status: "invalid",
    result: null,
    error,
    loading: null,
    initialDigest: null,
    simulationDigest: null,
    final: null,
    finalFeed: null,
    physicalFinal: null,
    metrics: null,
    api: null,
    ledger: [],
    decisions: [],
    windows: [],
    wallSeconds: 0,
  };
}

export async function runCombatTrial(
  trial: FightTrial,
  options: CombatTrialOptions = {},
): Promise<FightRow> {
  const startedAt = performance.now();
  const chargeJevRequests = trial.policy === "jev" && options.replay === undefined;
  let encounter: Encounter | undefined;
  const ledger: FightLedgerEntry[] = [];
  const decisions: FightDecisionTrace[] = [];
  const windows: FightWindow[] = [];
  const api: FightApiUsage = { chargedRequests: 0, inputTokens: 0, outputTokens: 0, usageUnavailableRequests: 0 };
  const lostByType = emptyTypeCounts();
  const evidence = new PhysicalEvidence();
  let loading: FightLoading | null = null;
  let initialDigest: string | null = null;
  let attemptedActions = 0;
  let physicalTick = 0;
  let largestRollingIncoming = 0;
  let rollingIncoming = 0;
  const incomingTicks = new Array<number>(CYCLE_TICKS).fill(0);
  let incomingCursor = 0;
  let incomingCount = 0;
  let activeTrace: FightDecisionTrace | null = null;
  let failure: string | null = null;

  const retainStep = (
    stage: FightLedgerEntry["stage"],
    action: number | null,
    step: EncounterStep,
  ): void => {
    physicalTick += 1;
    evidence.inspect(encounter!.simulation, step.events, step.combat, step.admissions);
    for (const event of step.events) if (event.kind === "lost") lostByType[event.type] += 1;

    const incoming = step.combat.delta.skullDamage + step.combat.delta.bombDamageToPlayer;
    const previous = incomingCount === CYCLE_TICKS ? incomingTicks[incomingCursor]! : 0;
    if (incomingCount < CYCLE_TICKS) incomingCount += 1;
    incomingTicks[incomingCursor] = incoming;
    incomingCursor = (incomingCursor + 1) % CYCLE_TICKS;
    rollingIncoming += incoming - previous;
    largestRollingIncoming = Math.max(largestRollingIncoming, rollingIncoming);

    if (
      step.events.length > 0 ||
      step.combat.effects.length > 0 ||
      totalsNonzero(step.combat.delta) ||
      step.admissions.length > 0 ||
      step.waveEvents.length > 0
    ) {
      ledger.push({
        tick: physicalTick,
        stage,
        action,
        events: step.events.map((event) => ({ ...event, position: { ...event.position } })),
        combat: {
          state: {
            ...step.combat.state,
            enemies: step.combat.state.enemies.map((enemy) => ({ ...enemy })),
            totals: { ...step.combat.state.totals },
          },
          delta: { ...step.combat.delta },
          effects: step.combat.effects.map((effect) => ({
            ...effect,
            position: { ...effect.position },
            enemyHits: effect.enemyHits.map((hit) => ({ ...hit })),
          })),
        },
        admissions: step.admissions.map(copyAdmission),
        waveEvents: step.waveEvents.map((event) => ({
          ...event,
          enemyIds: [...event.enemyIds],
        })),
        feed: stableFeed(encounter!.preview()),
        feedStreams: stableFeedStreams(encounter!.snapshot().feedStreams),
      });
    }
  };

  try {
    validateFightTrial(trial);
    const factory = options.encounterFactory ?? createEncounter;
    encounter = await factory({ ...DEFAULT_TUNING, seed: trial.seed }, trial.profile.config);
    const plannedStarting = plannedStartingCounts(encounter);

    while (encounter.snapshot().phase === "loading" && physicalTick < MAX_LOADING_TICKS) {
      retainStep("loading", null, encounter.step());
    }
    const loadingSnapshot = encounter.snapshot();
    if (loadingSnapshot.phase === "error")
      throw new Error(loadingSnapshot.error ?? "Encounter loading failed");
    if (loadingSnapshot.phase === "loading")
      throw new Error("Encounter did not leave loading by the loading cap");
    if (loadingSnapshot.phase !== "active" && loadingSnapshot.phase !== "finished")
      throw new Error(`Encounter left loading in an invalid phase: ${loadingSnapshot.phase}`);
    if (
      loadingSnapshot.phase === "active" &&
      (loadingSnapshot.loading.ticks < MIN_LOADING_TICKS ||
        loadingSnapshot.loading.ticks > MAX_LOADING_TICKS)
    ) throw new Error("Encounter loading finished outside the preregistered bounds");
    if (loadingSnapshot.phase === "active" && encounter.simulation.stats().pendingRain !== 0)
      throw new Error("Encounter became active with pending opening rain");

    const admittedStarting = evidence.spawnedByType();
    if (
      loadingSnapshot.phase === "active" &&
      COIN_TYPES.some((type) => plannedStarting[type] !== admittedStarting[type])
    ) throw new Error("Opening type quotas were not fully admitted");
    loading = {
      ticks: loadingSnapshot.loading.ticks,
      plannedStarting,
      admittedStarting,
      collectedByType: { ...loadingSnapshot.loading.collectedByType },
      lostByType: { ...loadingSnapshot.loading.lostByType },
      detonated: loadingSnapshot.loading.detonated,
      nativeFeedIds: evidence.nativeFeedIds(),
    };
    initialDigest = initialFightDigest(encounter);

    if (loadingSnapshot.phase === "active") {
      const observer = createCombatObserver();
      try {
        let policy = options.policy;
        let stopped = false;
        for (let opportunity = 1; opportunity <= trial.actions && !stopped; opportunity += 1) {
          const observation = observer.observe(encounter);
          const candidateAimXs = observation.candidates.map((candidate) => candidate.aimX);
          if (candidateAimXs.length !== 5 || candidateAimXs.some((aim) => !Number.isFinite(aim)))
            throw new Error("Combat observer returned invalid candidate aim positions");
          const actionAdmissions: RoundAdmission[] = [];
          const trace: FightDecisionTrace = {
            opportunity,
            tick: physicalTick,
            observation,
            suggested: null,
            executed: null,
            aimX: null,
            waitTicks: 0,
            waitAdvancedTicks: 0,
            mechanicalWaitAdvancedTicks: 0,
            windowAdvancedTicks: 0,
            admissions: actionAdmissions,
            requestCharged: false,
            error: null,
          };
          decisions.push(trace);
          activeTrace = trace;

          let suggested: SolverDecision;
          try {
            policy ??= createPolicy(trial);
            if (chargeJevRequests) {
              trace.requestCharged = true;
              api.chargedRequests += 1;
            }
            suggested = await policy({ observation, candidateAimXs, timing: trial.timing });
            validateDecision(suggested);
            trace.suggested = copyDecision(suggested);
            if (chargeJevRequests) {
              if (suggested.inputTokens === undefined || suggested.outputTokens === undefined)
                api.usageUnavailableRequests += 1;
              api.inputTokens += suggested.inputTokens ?? 0;
              api.outputTokens += suggested.outputTokens ?? 0;
            }
          } catch (error) {
            if (trace.requestCharged) api.usageUnavailableRequests += 1;
            trace.error = errorMessage(error);
            throw error;
          }

          const executed: SolverAction = {
            lane: suggested.action.lane,
            waitQuarters: trial.timing === "fixed" ? 0 : suggested.action.waitQuarters,
          };
          const aimX = candidateAimXs[executed.lane];
          if (aimX === undefined) throw new Error("Combat policy selected an unavailable lane");
          trace.executed = { ...executed };
          trace.aimX = aimX;
          trace.waitTicks = executed.waitQuarters * QUARTER_CYCLE_TICKS;

          for (let wait = 0; wait < trace.waitTicks; wait += 1) {
            const step = encounter.step();
            retainStep("wait", opportunity, step);
            trace.waitAdvancedTicks += 1;
            if (step.combat.state.result !== null) {
              stopped = true;
              break;
            }
          }
          if (stopped) break;

          const feedBefore = canonicalJson(stableFeed(encounter.preview()));
          const expectedAction = encounter.snapshot().acceptedActions + 1;
          attemptedActions += 1;
          const accepted = encounter.drop(aimX, DEFAULT_CHUTES);
          if (!accepted) {
            encounter.cancelDrops();
            if (canonicalJson(stableFeed(encounter.preview())) !== feedBefore) {
              trace.error = "Refused combat admission consumed or replaced native feed stock";
              throw new Error(trace.error);
            }
            trace.error = `Combat admission failed at tick ${physicalTick}, action ${opportunity}, aim ${aimX}, accepted ${encounter.snapshot().acceptedActions}`;
            throw new Error(trace.error);
          }
          if (encounter.snapshot().acceptedActions !== expectedAction)
            throw new Error("Accepted combat action did not advance exactly once");

          let firstReleaseStep: EncounterStep | null = null;
          while (actionAdmissions.length === 0 &&
            trace.mechanicalWaitAdvancedTicks < MECHANICAL_WAIT_LIMIT_TICKS) {
            const step = encounter.step();
            const fragments = step.admissions.filter((admission) => admission.action === expectedAction);
            if (fragments.length > 0) {
              actionAdmissions.push(...fragments.map(copyAdmission));
              firstReleaseStep = step;
              break;
            }
            retainStep("wait", expectedAction, step);
            trace.mechanicalWaitAdvancedTicks += 1;
            if (step.combat.state.result !== null) {
              stopped = true;
              break;
            }
          }
          if (stopped) break;
          const firstAdmission = actionAdmissions[0];
          if (!firstAdmission) {
            trace.error = `Mechanical feed stalled for ${MECHANICAL_WAIT_LIMIT_TICKS} ticks without admitting action ${expectedAction}`;
            throw new Error(trace.error);
          }

          const window: FightWindow = {
            action: expectedAction,
            startTick: firstAdmission.tick,
            admittedAtTick: firstAdmission.tick,
            endTick: physicalTick,
            waitTicks: trace.waitAdvancedTicks + trace.mechanicalWaitAdvancedTicks,
            catches: 0,
            detonations: 0,
            enemyDamage: 0,
            playerDamage: 0,
            healingUsed: 0,
            currency: 0,
            dry: true,
            noEnemyDamage: true,
          };
          for (let offset = 0; offset < CYCLE_TICKS; offset += 1) {
            const capturedStep = offset === 0 ? firstReleaseStep : null;
            const usesCapturedStep = capturedStep !== null;
            const step = capturedStep ?? encounter.step();
            if (!usesCapturedStep) {
              actionAdmissions.push(...step.admissions
                .filter((admission) => admission.action === expectedAction)
                .map(copyAdmission));
            }
            retainStep("window", expectedAction, step);
            trace.windowAdvancedTicks += 1;
            for (const event of step.events) {
              if (event.kind === "collected") window.catches += 1;
              else if (event.kind === "detonated") window.detonations += 1;
            }
            window.enemyDamage += step.combat.delta.enemyHpRemoved;
            window.playerDamage += step.combat.delta.skullDamage + step.combat.delta.bombDamageToPlayer;
            window.healingUsed += step.combat.delta.healingUsed;
            window.currency += step.combat.delta.currencyGained;
            if (step.combat.state.result !== null) {
              stopped = true;
              break;
            }
          }
          window.endTick = physicalTick;
          window.dry = window.catches === 0 && window.detonations === 0;
          window.noEnemyDamage = window.enemyDamage === 0;
          windows.push(window);
        }

        if (encounter.snapshot().result === null && encounter.snapshot().acceptedActions === trial.actions) {
          for (let tail = 0; tail < CYCLE_TICKS; tail += 1) {
            const step = encounter.step();
            retainStep("tail", null, step);
            if (step.combat.state.result !== null) break;
          }
        }
      } finally {
        observer.dispose();
      }
    }
  } catch (error) {
    failure = errorMessage(error);
    if (activeTrace && activeTrace.error === null) activeTrace.error = failure;
  }

  const final = encounter?.snapshot() ?? null;
  const finalFeed = encounter ? stableFeed(encounter.preview()) : null;
  const physicalFinal: SimulationStats | null = encounter?.simulation.stats() ?? null;
  const metrics: FightMetrics | null = final
    ? buildMetrics(final, windows, attemptedActions, decisions.length, physicalTick,
      largestRollingIncoming, lostByType)
    : null;
  const digestResult = failure === null ? final?.result ?? "budget-exhausted" : "invalid";
  const simulationDigest: string | null = initialDigest && final && finalFeed && physicalFinal
    ? simulationFightDigest(initialDigest, ledger, final, finalFeed, physicalFinal, digestResult)
    : null;
  const result = failure === null && final
    ? (final.result ?? "budget-exhausted")
    : null;
  encounter?.dispose();

  return {
    trial,
    status: failure === null ? "complete" : "invalid",
    result,
    error: failure,
    loading,
    initialDigest,
    simulationDigest,
    final,
    finalFeed,
    physicalFinal,
    metrics,
    api,
    ledger,
    decisions,
    windows,
    wallSeconds: (performance.now() - startedAt) / 1000,
  };
}

export async function replayCombatTrial(source: FightRow): Promise<{ row: FightRow; check: ReplayCheck }> {
  let decisionIndex = 0;
  const replayPolicy: CombatSolverPolicy = (state) => {
    const trace = source.decisions[decisionIndex++];
    if (!trace) throw new Error(`Replay trace is missing decision ${decisionIndex}`);
    if (!trace.suggested || !trace.executed) {
      if (source.status === "invalid" && trace.error !== null &&
        trace.suggested === null && trace.executed === null)
        throw new Error(trace.error);
      throw new Error(`Replay trace is missing decision ${decisionIndex}`);
    }
    const expectedExecuted: SolverAction = {
      lane: trace.suggested.action.lane,
      waitQuarters: source.trial.timing === "fixed" ? 0 : trace.suggested.action.waitQuarters,
    };
    const expectedAim = state.candidateAimXs[expectedExecuted.lane];
    if (
      canonicalJson(expectedExecuted) !== canonicalJson(trace.executed) ||
      expectedAim !== trace.aimX ||
      expectedExecuted.waitQuarters * QUARTER_CYCLE_TICKS !== trace.waitTicks
    ) throw new Error(`Replay trace decision ${decisionIndex} is internally inconsistent`);
    return copyDecision(trace.suggested);
  };
  const row = await runCombatTrial(source.trial, { replay: source, policy: replayPolicy });
  const initialDigestMatch = row.initialDigest !== null && row.initialDigest === source.initialDigest;
  const ledgerMatch = canonicalJson(row.ledger) === canonicalJson(source.ledger);
  const simulationDigestMatch = row.simulationDigest !== null && row.simulationDigest === source.simulationDigest;
  const outcomeMatch = row.result === source.result && canonicalJson(row.final) === canonicalJson(source.final);
  const consumedAllDecisions = decisionIndex === source.decisions.length;
  const mismatches = [
    !initialDigestMatch && "initial digest",
    !ledgerMatch && "ledger",
    !simulationDigestMatch && "simulation digest",
    !outcomeMatch && "final outcome",
    !consumedAllDecisions && "decision count",
    row.status !== source.status && "completion status",
    source.status === "invalid" && row.error !== source.error && "recorded failure",
  ].filter((item): item is string => typeof item === "string");
  const check: ReplayCheck = {
    trialId: source.trial.id,
    matched: mismatches.length === 0,
    initialDigestMatch,
    ledgerMatch,
    simulationDigestMatch,
    outcomeMatch,
    error: mismatches.length === 0 ? null : `Replay mismatch: ${mismatches.join(", ")}`,
  };
  return { row, check };
}
