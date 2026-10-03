import type { FightRow, FightTrial, ReplayCheck } from "./combat-contracts";
import { FIGHT_VERSION } from "./combat-contracts";
import { canonicalJson, validateFightTrial } from "./combat-protocol";
import { replayCombatTrial } from "./combat-trial";

interface FightReplayResult {
  trials: FightTrial[];
  checks: ReplayCheck[];
}

function failedCheck(trialId: string, error: string): ReplayCheck {
  return {
    trialId,
    matched: false,
    initialDigestMatch: false,
    ledgerMatch: false,
    simulationDigestMatch: false,
    outcomeMatch: false,
    error,
  };
}

function isReplayRow(value: unknown): value is FightRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (
    !("trial" in value) ||
    !("status" in value) ||
    !("loading" in value) ||
    !("finalFeed" in value) ||
    !("ledger" in value) ||
    !("decisions" in value) ||
    !("windows" in value)
  ) return false;
  if (value.status !== "complete" && value.status !== "invalid") return false;
  if (
    !Array.isArray(value.ledger) ||
    value.ledger.some((entry) => typeof entry !== "object" || entry === null ||
      !("admissions" in entry) || !Array.isArray(entry.admissions) ||
      !("waveEvents" in entry) || !Array.isArray(entry.waveEvents) ||
      !("feed" in entry) || !Array.isArray(entry.feed) ||
      !("feedStreams" in entry) || !Array.isArray(entry.feedStreams)) ||
    !Array.isArray(value.decisions) ||
    value.decisions.some((decision) => typeof decision !== "object" || decision === null ||
      !("admissions" in decision) || !Array.isArray(decision.admissions)) ||
    !Array.isArray(value.windows)
  ) return false;
  try {
    validateFightTrial(value.trial);
  } catch {
    return false;
  }
  return true;
}

/** Verify the entire planned cohort, including missing and duplicate evidence. */
export async function replayFightReport(source: unknown): Promise<FightReplayResult> {
  const invalidReport = (error: string): FightReplayResult => ({
    trials: [],
    checks: [failedCheck("<invalid-report>", error)],
  });
  if (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    "version" in source &&
    source.version === "first-fight-v1"
  ) return invalidReport("Unsupported replay version: first-fight-v1; use its recorded engine revision");
  if (typeof source !== "object" || source === null || Array.isArray(source) ||
      !("version" in source) || source.version !== FIGHT_VERSION ||
      !("rows" in source) || !Array.isArray(source.rows) || !("protocol" in source))
    return invalidReport("Replay source is not a versioned fight report with a rows array");
  const protocol = source.protocol;
  if (typeof protocol !== "object" || protocol === null || Array.isArray(protocol) ||
      !("plannedTrials" in protocol) || !Array.isArray(protocol.plannedTrials) || protocol.plannedTrials.length === 0)
    return invalidReport("Replay source requires a nonempty planned-trial manifest");

  const rawTrials: readonly unknown[] = protocol.plannedTrials;
  const trials: FightTrial[] = [];
  const expected = new Map<string, FightTrial>();
  for (const trial of rawTrials) {
    try {
      validateFightTrial(trial);
    } catch (error) {
      return invalidReport(`Replay source has an invalid planned trial: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (expected.has(trial.id))
      return invalidReport(`Replay source has a duplicate planned trial: ${trial.id}`);
    expected.set(trial.id, trial);
    trials.push(trial);
  }

  const evidence = new Map<string, unknown[]>();
  const rawRows: readonly unknown[] = source.rows;
  for (const value of rawRows) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("trial" in value))
      return { trials, checks: [failedCheck("<invalid-report>", "Replay source contains a row without a trial identity")] };
    const trial = value.trial;
    if (typeof trial !== "object" || trial === null || Array.isArray(trial) ||
        !("id" in trial) || typeof trial.id !== "string" || !expected.has(trial.id))
      return { trials, checks: [failedCheck("<invalid-report>", "Replay source contains an unplanned or unidentified trial row")] };
    const rows = evidence.get(trial.id) ?? [];
    rows.push(value);
    evidence.set(trial.id, rows);
  }

  const checks: ReplayCheck[] = [];
  for (const trial of trials) {
    const rows = evidence.get(trial.id);
    if (!rows || rows.length !== 1) {
      checks.push(failedCheck(trial.id, rows ? "Replay source has duplicate trial evidence" : "Replay source is missing planned trial evidence"));
      continue;
    }
    const value = rows[0];
    if (!isReplayRow(value)) {
      checks.push(failedCheck(trial.id, "Replay source row failed the FightRow boundary check"));
      continue;
    }
    if (canonicalJson(value.trial) !== canonicalJson(trial)) {
      checks.push(failedCheck(trial.id, "Replay source row does not match its planned trial"));
      continue;
    }
    try {
      checks.push((await replayCombatTrial(value)).check);
    } catch (error) {
      checks.push(failedCheck(trial.id, error instanceof Error ? error.message : String(error)));
    }
  }
  return { trials, checks };
}
