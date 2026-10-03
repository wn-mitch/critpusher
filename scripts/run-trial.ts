import { DEFAULT_CHUTES } from "../src/chutes";
import type { EncounterStep } from "../src/combat/types";
import { createCombatObserver } from "../src/experiments/combat-observation";
import { chooseCombatCenterAction, chooseCombatRuleAction, createCombatRandomPolicy } from "../src/experiments/combat-policy";
import type { CombatObserver, CombatSolverPolicy } from "../src/experiments/solver-contracts";
import { createRun } from "../src/run/run";
import type { Run, RunSnapshot } from "../src/run/types";
import { emptyTypeCounts } from "./combat-evidence";
import { validateAction } from "./release-trial";
import type { EncounterMetrics, RunRow, RunTrial, TickTrace } from "./run-contracts";
import { assertTerminalFrozen, physicalDigest, physicalState, RunEvidence, RunIdentity, tickState } from "./run-evidence";
import { canonicalJson, digest, LOADING_LIMIT, MECHANICAL_LIMIT, profileFor, ROUND_LIMIT, validateRunTrial, WINDOW_TICKS } from "./run-protocol";
import { runShop } from "./run-shopping";
import { nativeActionPending, RunActionWindow } from "./run-window";

export function invalidRunRow(trial: RunTrial, error: string): RunRow {
  return { trial, status: "invalid", error, failurePhase: "initialization", decisions: [], shops: [], trace: [], encounters: [], final: null, finalPhysical: null, finalDigest: null };
}
export function actionRoundCost(releaseMode: RunSnapshot["build"]["releaseMode"]): number {
  return releaseMode === "dump" ? 5 : 1;
}

export function canScheduleAction(acceptedRounds: number, releaseMode: RunSnapshot["build"]["releaseMode"]): boolean {
  if (!Number.isSafeInteger(acceptedRounds) || acceptedRounds < 0 || acceptedRounds > ROUND_LIMIT) return false;
  return acceptedRounds + actionRoundCost(releaseMode) <= ROUND_LIMIT;
}
function newMetrics(entry: RunSnapshot): EncounterMetrics {
  return { encounterIndex: entry.encounterIndex, loadingOutcome: null, acquiredBuild: entry.purchases.length > 0,
    completedWaves: 0, terminalHp: entry.playerHp, entryHp: entry.playerHp, grossIncoming: 0,
    coinHealingUsed: 0, coinHealingWasted: 0, recoveryUsed: 0, recoveryWasted: 0, netAttrition: 0,
    moneyEarned: 0, moneySpent: 0, moneyCarried: entry.currency, legalPurchaseOpportunities: 0, unaffordablePurchaseOpportunities: 0,
    bags: entry.playerChutes, nativeBags: [], chuteCount: entry.playerChutes.length, stickers: entry.stickers,
    swordDamage: entry.build.swordDamage, bombDamage: entry.build.bombDamage, comboDistribution: {},
    acceptedActions: 0, admittedRounds: 0, burstDurations: [], mechanicalWaitTicks: 0, burstStallTicks: 0,
    escalationTriggers: [], discardedDamage: 0, enemyHpRemoved: 0, lostCoins: emptyTypeCounts(), lostGizmos: 0, gizmoCurrency: 0,
    outcome: "unfinished", failurePhase: null, failureCause: null };
}
function finishMetrics(metrics: EncounterMetrics, entry: RunSnapshot, snapshot: RunSnapshot): void {
  const combat = snapshot.encounter;
  const recovery = snapshot.recoveries.find((value) => value.encounterIndex === metrics.encounterIndex);
  metrics.completedWaves = combat.waveIndex + Number(combat.result === "victory" || combat.result === "simultaneous-defeat");
  metrics.terminalHp = combat.playerHp;
  metrics.grossIncoming = combat.totals.skullDamage + combat.totals.bombDamageToPlayer;
  metrics.coinHealingUsed = combat.totals.healingUsed;
  metrics.coinHealingWasted = combat.totals.healingWasted;
  metrics.recoveryUsed = recovery?.used ?? 0;
  metrics.recoveryWasted = recovery?.wasted ?? 0;
  metrics.netAttrition = metrics.grossIncoming - metrics.coinHealingUsed;
  metrics.moneyEarned = snapshot.earnedCurrency - entry.earnedCurrency;
  metrics.moneySpent = snapshot.spentCurrency - entry.spentCurrency;
  metrics.moneyCarried = snapshot.currency;
  metrics.nativeBags = combat.feedStreams;
  metrics.acceptedActions = combat.acceptedActions;
  metrics.admittedRounds = combat.acceptedRounds;
  metrics.discardedDamage = combat.totals.discardedDamage;
  metrics.enemyHpRemoved = combat.totals.enemyHpRemoved;
  metrics.outcome = combat.result ?? (snapshot.phase === "error" ? "error" : "unfinished");
}

export async function runWholeTrial(trial: RunTrial, options: { replay?: Pick<RunRow, "decisions" | "shops"> } = {}): Promise<RunRow> {
  const row = invalidRunRow(trial, "Trial did not initialize");
  let run: Run | undefined;
  let identity: RunIdentity | undefined;
  let observer: CombatObserver | undefined;
  let evidence: RunEvidence | undefined;
  let entry: RunSnapshot | undefined;
  let metrics: EncounterMetrics | undefined;
  let phase = "initialization";
  let decisionCursor = 0;
  let shopCursor = 0;
  const escalations = new Set<string>();
  const retain = (stage: TickTrace["stage"], step: EncounterStep): void => {
    evidence!.inspect(run!, step);
    identity!.observe(run!, step);
    const snapshot = run!.snapshot();
    const state = identity!.normalize(tickState(run!));
    const tick = snapshot.encounter.tick;
    if (step.events.length || step.gizmoEvents.length || step.admissions.length || step.waveEvents.length || snapshot.phase !== "encounter") {
      row.trace.push({ kind: "tick", encounterIndex: snapshot.encounterIndex, stage, tick, step: identity!.normalize(step), state });
    } else {
      const previous = row.trace.at(-1);
      const current = digest(state);
      if (previous?.kind === "quiet" && previous.encounterIndex === snapshot.encounterIndex && previous.stage === stage && previous.through === tick - 1) {
        previous.through = tick;
        previous.digest = digest([previous.digest, current]);
      } else row.trace.push({ kind: "quiet", encounterIndex: snapshot.encounterIndex, stage, from: tick, through: tick, digest: current });
    }
    for (const event of step.events) if (event.kind === "lost") metrics!.lostCoins[event.type]++;
    for (const event of step.gizmoEvents) {
      if (event.kind === "lost") metrics!.lostGizmos++;
      else metrics!.gizmoCurrency += event.currency;
    }
    for (const effect of step.combat.effects) if (effect.type === "sword") {
      const key = String(effect.swordMultiplier);
      metrics!.comboDistribution[key] = (metrics!.comboDistribution[key] ?? 0) + 1;
    }
    // Combat state retains dying enemies even when the encounter snapshot has entered reinforcements.
    for (const enemy of step.combat.state.enemies) if (enemy.kind === "escalator") {
      for (const threshold of [5, 10]) {
        const key = `${enemy.id}/${threshold}`;
        if (enemy.admittedRounds >= threshold && !escalations.has(key)) {
          escalations.add(key);
          metrics!.escalationTriggers.push({ enemyId: enemy.id, threshold, tick });
        }
      }
    }
    if (snapshot.encounter.acceptedRounds > ROUND_LIMIT) throw new Error("Admitted-round budget exceeded");
    if (snapshot.phase === "error") throw new Error(snapshot.error ?? "Encounter loader failed");
  };
  const advance = (stage: TickTrace["stage"]): EncounterStep => {
    phase = stage;
    const before = run!.encounter.snapshot().tick;
    const step = run!.step();
    if (run!.encounter.snapshot().tick !== before + 1) throw new Error("Active run did not advance one physical tick");
    retain(stage, step);
    return step;
  };
  try {
    validateRunTrial(trial);
    const profile = profileFor(trial.build);
    run = await createRun({ seed: trial.seed });
    identity = new RunIdentity(run.snapshot().encounter.completionSerial);
    if (!run.chooseStarter(profile.starter)) throw new Error(run.snapshot().error ?? "Starter selection refused");
    let policy: CombatSolverPolicy | undefined;
    if (!options.replay) policy = trial.policy === "center" ? chooseCombatCenterAction : trial.policy === "random" ? createCombatRandomPolicy(trial.seed) : chooseCombatRuleAction;
    while (run.snapshot().phase === "encounter") {
      entry = run.snapshot();
      metrics = newMetrics(entry);
      row.encounters.push(metrics);
      evidence = new RunEvidence(run);
      identity.observe(run);
      row.trace.push({ kind: "entry", encounterIndex: entry.encounterIndex, state: identity.normalize({ starter: profile.starter, run: entry, physical: physicalState(run) }) });
      let loading = 0;
      while (run.snapshot().phase === "encounter" && run.encounter.snapshot().phase === "loading" && loading < LOADING_LIMIT) {
        advance("loading");
        loading++;
      }
      if (run.encounter.snapshot().phase === "loading") throw new Error("Loading stalled at 1440 ticks");
      if (run.encounter.snapshot().result) metrics.loadingOutcome = run.encounter.snapshot().result === "victory" ? "victory" : "defeat";
      observer = createCombatObserver();
      let roundBudgetBlocked = false;
      for (let opportunity = 0; opportunity < trial.actions && run.snapshot().phase === "encounter" && run.encounter.snapshot().acceptedRounds < ROUND_LIMIT; opportunity++) {
        if (!canScheduleAction(run.encounter.snapshot().acceptedRounds, run.snapshot().build.releaseMode)) {
          roundBudgetBlocked = true;
          break;
        }
        phase = "decision";
        const observation = observer.observe(run.encounter);
        const candidateAimXs = observation.candidates.map((candidate) => candidate.aimX);
        if (candidateAimXs.length !== 5 || candidateAimXs.some((aim) => !Number.isFinite(aim))) throw new Error("Observer provided invalid candidate bounds");
        const recorded = options.replay?.decisions[decisionCursor];
        if (options.replay && (!recorded || recorded.encounterIndex !== entry.encounterIndex || recorded.tick !== run.encounter.snapshot().tick))
          throw new Error("Replay decision missing or at the wrong boundary");
        const action = options.replay ? recorded!.action : (await policy!({ observation, candidateAimXs, timing: "adaptive" })).action;
        validateAction(action);
        const aimX = candidateAimXs[action.lane];
        if (aimX === undefined) throw new Error("Decision selected unavailable aim lane");
        const decision = identity.normalize({ encounterIndex: entry.encounterIndex, tick: run.encounter.snapshot().tick, observation, action: { ...action }, aimX });
        row.decisions.push(decision);
        decisionCursor++;
        if (recorded && canonicalJson(recorded) !== canonicalJson(decision)) throw new Error("Replay public observation/decision mismatch");
        for (let wait = 0; wait < action.waitQuarters * WINDOW_TICKS / 4 && run.snapshot().phase === "encounter"; wait++) advance("wait");
        if (run.snapshot().phase !== "encounter") break;
        const releaseBoundary = run.encounter.snapshot();
        let mechanicalTicks = 0;
        let before: RunSnapshot["encounter"] | null = null;
        let accepted: number | null = null;
        while (run.snapshot().phase === "encounter") {
          const current = run.encounter.snapshot();
          const interrupted = current.waveIndex !== releaseBoundary.waveIndex ||
            current.interruptedRounds > releaseBoundary.interruptedRounds;
          if (interrupted) break;
          if (!nativeActionPending(current, run.encounter.preview())) {
            phase = "release";
            const scheduled = run.drop(aimX, { ...DEFAULT_CHUTES, dropsPerAction: 1 });
            const afterSchedule = run.encounter.snapshot();
            if (scheduled) {
              if (afterSchedule.acceptedActions !== current.acceptedActions + 1)
                throw new Error("Accepted action did not advance once");
              before = current;
              accepted = afterSchedule.acceptedActions;
              break;
            }
            if (afterSchedule.acceptedActions !== current.acceptedActions)
              throw new Error("Rejected release changed accepted action accounting");
          }
          advance("mechanical");
          metrics.mechanicalWaitTicks++;
          mechanicalTicks++;
          const clearance = run.encounter.snapshot();
          if (run.snapshot().phase !== "encounter" ||
            clearance.waveIndex !== releaseBoundary.waveIndex ||
            clearance.interruptedRounds > releaseBoundary.interruptedRounds) break;
          if (mechanicalTicks >= MECHANICAL_LIMIT)
            throw new Error(`Mechanical feed stalled for 1440 ticks before action ${releaseBoundary.acceptedActions + 1}`);
        }
        if (run.snapshot().phase !== "encounter") break;
        if (before === null || accepted === null) continue;
        const releaseMode = run.snapshot().build.releaseMode;
        const rowsPerAction = actionRoundCost(releaseMode);
        const window = new RunActionWindow();
        while (run.snapshot().phase === "encounter") {
          const step = advance(window.firstAdmission === null ? "mechanical" : "window");
          const fragments = step.admissions.filter((fragment) => fragment.action === accepted).length;
          const snapshot = run.encounter.snapshot();
          const pending = nativeActionPending(snapshot, run.encounter.preview());
          const result = window.advance(fragments, pending, snapshot.interruptedRounds > before.interruptedRounds);
          if (run.snapshot().phase !== "encounter" || result === "complete") break;
          if (result === "stalled") throw new Error(`Mechanical feed stalled for 1440 ticks: action ${accepted}`);
        }
        metrics.mechanicalWaitTicks += window.mechanicalWaitTicks;
        metrics.burstStallTicks += window.stallTicks;
        if (rowsPerAction === 5 && window.firstAdmission !== null) metrics.burstDurations.push((window.lastAdmission ?? window.firstAdmission) - window.firstAdmission + 1);
      }
      for (let tail = 0; tail < WINDOW_TICKS && run.snapshot().phase === "encounter"; tail++) advance("tail");
      observer.dispose();
      observer = undefined;
      finishMetrics(metrics, entry, run.snapshot());
      if (run.snapshot().phase === "encounter") {
        metrics.failurePhase = "budget";
        metrics.failureCause = roundBudgetBlocked || run.encounter.snapshot().acceptedRounds >= ROUND_LIMIT
          ? "admitted-round-budget" : "action-budget";
        row.failurePhase = "budget";
        break;
      }
      assertTerminalFrozen(run);
      row.trace.push({ kind: "completion", encounterIndex: entry.encounterIndex, state: identity.normalize({ run: run.snapshot(), physical: physicalState(run) }) });
      if (run.snapshot().phase !== "shop") break;
      phase = "shop";
      const recordedShop = options.replay?.shops[shopCursor];
      if (options.replay && !recordedShop) throw new Error("Replay omitted a reached shop");
      const shop = runShop(run, profile, recordedShop);
      const normalized = identity.normalize(shop);
      if (recordedShop && canonicalJson(recordedShop) !== canonicalJson(normalized)) throw new Error("Replay shop transition mismatch");
      row.shops.push(normalized);
      shopCursor++;
      metrics.legalPurchaseOpportunities = shop.opportunities.filter((preview) => preview.allowed).length;
      metrics.unaffordablePurchaseOpportunities = shop.opportunities.filter((preview) => preview.blocker === "insufficient-currency").length;
      finishMetrics(metrics, entry, run.snapshot());
      row.trace.push({ kind: "shop", encounterIndex: entry.encounterIndex, state: normalized });
      if (!run.continueRun()) throw new Error("Next encounter transition refused");
    }
    row.status = run.snapshot().phase === "won" ? "won" : run.snapshot().phase === "lost" ? "lost" : "unfinished";
    row.error = null;
    if (row.status !== "unfinished") row.failurePhase = null;
  } catch (error) {
    row.status = "invalid";
    row.error = error instanceof Error ? error.message : String(error);
    row.failurePhase = phase;
    if (metrics) { metrics.failurePhase = phase; metrics.failureCause = row.error; }
  } finally {
    observer?.dispose();
    if (run && identity) {
      if (metrics && entry) finishMetrics(metrics, entry, run.snapshot());
      identity.observe(run);
      row.final = identity.normalize(run.snapshot());
      row.finalPhysical = identity.normalize(physicalState(run));
      row.finalDigest = physicalDigest(run, identity);
    }
    run?.dispose();
  }
  return row;
}
