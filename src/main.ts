import "./style.css";

import type {
  Presentation,
  Simulation,
  SimulationStats,
  Tuning,
} from "./contracts";
import type {
  Encounter,
  EncounterSnapshot,
  EncounterStep,
} from "./combat/types";
import {
  createChuteLayout,
  DEFAULT_CHUTES,
  sanitizeChutes,
  type ChuteSettings,
} from "./chutes";
import { createAudioEngine } from "./audio";
import { createRun } from "./run/run";
import type { Run, RunSnapshot, StarterId, PurchaseRequest, PurchaseResult } from "./run/types";
import { exposeDevApi, type PerformanceReadings } from "./runtime/dev";
import { createPlacementProbe, type PlacementProbe } from "./experiments/panel";
import { createCollectionBurstTracker, createCombatBurstTracker } from "./feedback/cascade";
import { createPresentation } from "./presentation";
import { DEFAULT_TUNING } from "./simulation";
import { MACHINE_GEOMETRY } from "./machine-geometry";
import { bindControls, createAppUi, type InputController } from "./ui";

const FIXED_STEP_SECONDS = 1 / 60;
const MAX_STEPS_PER_FRAME = 6;
const MAX_FRAME_SECONDS = 0.25;
const CHUTE_LIMIT = MACHINE_GEOMETRY.aimHalfWidth;
const UI_UPDATE_INTERVAL_MS = 200;


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Critpusher cannot start because #app is missing.");

const audio = createAudioEngine();
let encounter: Encounter | undefined;
let run: Run | undefined;
let simulation: Simulation | undefined;
let presentation: Presentation | undefined;
let input: InputController | undefined;
let placementProbe: PlacementProbe | undefined;
let frameRequest = 0;
let previousFrameTime = 0;
let simulationClock = 0;
let accumulator = 0;
let chuteX = 0;
let chuteSettings: ChuteSettings = { ...DEFAULT_CHUTES };
let userPaused = false;
let hidden = document.hidden;
let reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
let soundWanted = true;
let armPromise: Promise<void> | undefined;
let deferredReleaseGeneration = 0;
let lastUiUpdate = 0;
let lastUiPhase = "";
const collectionBursts = createCollectionBurstTracker();
const combatBursts = createCombatBurstTracker();
let lastReleaseKey = "";
let disposed = false;

const performanceReadings: PerformanceReadings = {
  fps: 0,
  renderMs: 0,
  frameMs: 0,
  cascadeMs: 0,
  droppedSteps: 0,
};

const isPaused = (): boolean => userPaused || hidden;

const ui = createAppUi(root, {
  initialTuning: DEFAULT_TUNING,
  callbacks: {
    onPauseChange: (paused) => setPaused(paused),
    onSoundChange: (enabled) => setSound(enabled),
    onRestart: reset,
    onChooseStarter: chooseStarter,
    onPreviewPurchase: (request) => {
      if (!run) throw new Error("Run is not ready.");
      return run.previewPurchase(request);
    },
    onPurchase: purchase,
    onContinueRun: continueRun,
    onLiveTuningChange: (patch) => {
      if (!run) return;
      run.setTuning(patch);
      syncChutes(chuteX);
      renderPausedState();
    },
    onChuteSettingsChange: (settings) => {
      if (!simulation) return;
      chuteSettings = sanitizeChutes(settings, simulation.tuning);
      syncChutes(chuteX);
      renderPausedState();
    },
    onResetTuningChange: () => {
      ui.setStatus(
        "Reseed the pile to apply seed, density, coin size, or shelf length changes.",
      );
    },
    onReducedMotionChange: (reduced) => {
      reducedMotion = reduced;
      root.dataset.reducedMotion = String(reduced);
      ui.setReducedMotion(reduced);
    },
    onVolumeChange: (volume) => {
      try {
        audio.setVolume(volume);
      } catch (error) {
        showAudioError(error);
      }
    },
  },
});

ui.setReducedMotion(reducedMotion);
root.dataset.reducedMotion = String(reducedMotion);
audio.setVolume(Number(ui.elements.volume.value));
runAudioLifecycle(audio.setHidden(hidden));

function resetClock(): void {
  previousFrameTime = 0;
  accumulator = 0;
}

function showAudioError(error: unknown): void {
  soundWanted = false;
  audio.setMuted(true);
  ui.setSoundEnabled(false);
  ui.elements.sound.disabled = true;
  const message = `Sound unavailable: ${errorMessage(error)}`;
  ui.elements.sound.title = message;
  ui.setStatus(message);
}

async function armAudio(): Promise<void> {
  if (!soundWanted || audio.armed) return;
  if (armPromise) return armPromise;
  armPromise = audio
    .arm()
    .then(() => {
      audio.setMuted(!soundWanted);
      ui.setSoundEnabled(soundWanted);
    })
    .catch((error: unknown) => {
      showAudioError(error);
      throw error;
    })
    .finally(() => {
      armPromise = undefined;
    });
  return armPromise;
}

function requestAudioArm(): void {
  void armAudio().catch(() => {
    // armAudio surfaces the actionable error in the app before rejecting.
  });
}

function setSound(enabled: boolean): void {
  soundWanted = enabled;
  if (!enabled) deferredReleaseGeneration += 1;
  audio.setMuted(!enabled);
  ui.setSoundEnabled(enabled);
  if (enabled) requestAudioArm();
}

function runAudioLifecycle(operation: Promise<void>): void {
  void operation.catch(showAudioError);
}

function setPaused(paused: boolean): void {
  userPaused = paused;
  const effectivePaused = isPaused();
  if (effectivePaused) deferredReleaseGeneration += 1;
  run?.setPaused(effectivePaused);
  resetClock();
  input?.cancelRepeats();
  ui.setPaused(effectivePaused);
  ui.setRhythm(effectivePaused ? "Paused" : "Ready", false);
  ui.setStatus(effectivePaused ? "Machine paused." : "Machine running.");
  runAudioLifecycle(audio.setPaused(effectivePaused));
  if (effectivePaused) renderPausedState(true);
  else if (simulation) updateUi(simulation.stats(), performance.now(), true);
}

function renderPausedState(forceUi = false): void {
  if (isPaused()) renderFrozenState(forceUi);
}

function syncChutes(requestedX: number): void {
  const tuning = simulation?.tuning ?? DEFAULT_TUNING;
  chuteSettings = sanitizeChutes(chuteSettings, tuning);
  const layout = createChuteLayout(
    encounter?.snapshot().chuteSlots ?? [],
    tuning,
    requestedX,
    chuteSettings.chuteSpacing,
  );
  chuteX = layout[0]?.x ?? 0;
  encounter?.setAim(chuteX, chuteSettings);
  ui.elements.aim.value = String(chuteX / CHUTE_LIMIT);
  ui.setChuteSettings(chuteSettings, tuning.radius);
}

function setAim(normalized: number): void {
  const safe = Math.min(
    1,
    Math.max(-1, Number.isFinite(normalized) ? normalized : 0),
  );
  syncChutes(safe * CHUTE_LIMIT);
  renderPausedState();
}

function setAimFromPointer(clientX: number, clientY: number): void {
  if (!presentation) return;
  syncChutes(presentation.pointerToChute(clientX, clientY));
  renderPausedState();
}

function drop(x = chuteX): boolean {
  if (!run || isPaused()) return false;
  if (x !== chuteX) syncChutes(x);
  const accepted = run.drop(chuteX, chuteSettings);
  if (accepted) {
    const queued = run.encounter.snapshot().remainingRounds;
    ui.setRhythm(
      `Release accepted${queued > 0 ? `; ${queued} coins per chute queued` : ""}`,
      true,
    );
    playReleaseFeedback(run.encounter.snapshot().lastAdmission);
  } else {
    ui.setRhythm("Release blocked", false);
  }
  return accepted;
}

function playReleaseFeedback(admission: EncounterSnapshot["lastAdmission"]): void {
  if (!admission) return;
  const key = `${admission.action}/${admission.round}`;
  if (key === lastReleaseKey) return;
  lastReleaseKey = key;
  if (audio.armed) audio.release();
  else {
    const generation = deferredReleaseGeneration;
    void armAudio().then(() => {
      if (generation === deferredReleaseGeneration) audio.release();
    }).catch(() => {
      // armAudio reports its error in the app.
    });
  }
}

function freshWorld(): void {
  if (!run || !simulation || !presentation) return;
  input?.cancelRepeats();
  deferredReleaseGeneration += 1;
  lastReleaseKey = "";
  collectionBursts.reset();
  combatBursts.reset();
  presentation.clearEffects();
  lastUiPhase = "";
  simulationClock = 0;
  audio.reset();
  placementProbe?.dispose();
  placementProbe = createPlacementProbe({
    host: ui.elements.tuningPanel, simulation, presentation, onChange: renderPausedState,
  });
  ui.elements.combatCues.textContent = "";
  ui.setFeedback("");
  ui.setError(null);
  syncChutes(0);
  performanceReadings.droppedSteps = 0;
  performanceReadings.cascadeMs = 0;
  resetClock();
  renderFrozenState(true);
}

function reset(tuning?: Partial<Tuning>): void {
  if (tuning) ui.setTuning(tuning);
  if (!run) return;
  if (tuning) run.setTuning(tuning);
  run.restart(tuning?.seed);
  run.setPaused(isPaused());
  freshWorld();
}

function chooseStarter(id: StarterId): boolean {
  if (!run) return false;
  const accepted = run.chooseStarter(id);
  if (accepted) freshWorld();
  else renderFrozenState(true);
  return accepted;
}

function continueRun(): boolean {
  if (!run) return false;
  const accepted = run.continueRun();
  if (accepted) freshWorld();
  else renderFrozenState(true);
  return accepted;
}

function purchase(request: PurchaseRequest): PurchaseResult {
  if (!run) throw new Error("Run is not ready.");
  const result = run.purchase(request);
  renderFrozenState(true);
  return result;
}

function recordDroppedDebt(seconds: number): void {
  const steps = Math.floor(seconds / FIXED_STEP_SECONDS);
  if (steps <= 0) return;
  performanceReadings.droppedSteps += steps;
  ui.setStatus(
    `Simulation overloaded: ${performanceReadings.droppedSteps} fixed steps dropped.`,
  );
}

function updateUi(
  stats: SimulationStats,
  timestamp: number,
  force = false,
): void {
  if (!force && timestamp - lastUiUpdate < UI_UPDATE_INTERVAL_MS) return;
  lastUiUpdate = timestamp;
  ui.updateStats(stats);
  ui.updateMetrics(stats, performanceReadings);
  if (run) {
    const snapshot = run.snapshot();
    const phase = `${snapshot.phase}/${snapshot.encounter.phase}/${snapshot.encounter.waveIndex}`;
    if (phase !== lastUiPhase) {
      lastUiPhase = phase;
      const messages: Record<RunSnapshot["phase"], string> = {
        starter: "Choose a kit above the cabinet. Combat begins with the opening rain.",
        encounter: snapshot.encounter.phase === "loading" ? "Opening pile settling; catches and impacts are live." : "Read the front target, aim, and release.",
        shop: "Victory. Recovery and payout applied. Review your next build in the machine shop.",
        won: "All encounters cleared. Start a new run with another kit.",
        lost: "Run ended. Start a new run with another kit.",
        error: snapshot.error ?? "Run unavailable. Restart to try again.",
      };
      ui.setStatus(messages[snapshot.phase]);
      if (snapshot.phase !== "encounter") {
        input?.cancelRepeats();
        deferredReleaseGeneration += 1;
      }
    }
    ui.updateEncounter(snapshot.encounter, encounter?.preview() ?? []);
    ui.updateRun(snapshot);
    presentation?.setStickers(snapshot.stickers);
    if (snapshot.error) ui.setError(snapshot.error);
  }
}

function encounterIsFrozen(): boolean {
  const snapshot = run?.snapshot();
  return !snapshot || snapshot.phase !== "encounter" || snapshot.encounter.phase === "error";
}

function processStepEvents(step: EncounterStep): void {
  for (const admission of step.admissions) {
    if (admission.newRound) playReleaseFeedback(admission);
  }
  if (!simulation || !presentation) return;
  const events = step.events;
  const burst = collectionBursts.collect(events, simulationClock);
  for (const event of step.gizmoEvents) {
    ui.setFeedback(event.kind === "collected"
      ? `Bell collected: +${event.currency} currency. Combo stays active; bell returns next encounter.`
      : "Bell lost. Combo stays active; bell returns next encounter.");
  }
  const combatBurst = combatBursts.collect(step.combat, simulationClock);
  if (events.length === 0) {
    if (step.admissions.length > 0) ui.setRhythm("Release admitted", true);
    return;
  }

  const cascadeStarted = performance.now();
  presentation.collect(events, reducedMotion, step.combat);
  placementProbe?.collect(events);
  audio.collect(events, burst ?? undefined);
  audio.combat(step.combat);
  ui.showCombat(step.combat);
  if (combatBurst) {
    const labels = [
      combatBurst.outgoingDamage > 0 ? `Enemy −${combatBurst.outgoingDamage}` : "",
      combatBurst.incomingDamage > 0 ? `Player −${combatBurst.incomingDamage}` : "",
      combatBurst.healingUsed > 0 ? `Heal +${combatBurst.healingUsed}` : "",
      combatBurst.currency > 0 ? `Currency +${combatBurst.currency}` : "",
    ].filter(Boolean);
    ui.setFeedback(labels.join(" · "));
  }
  performanceReadings.cascadeMs += performance.now() - cascadeStarted;
}

function advanceEncounterStep(): EncounterStep {
  if (!run) throw new Error("Run is not ready.");
  const step = run.step();
  simulationClock = run.simulation.stats().time;
  processStepEvents(step);
  return step;
}

function renderFrozenState(forceUi = false): void {
  if (!simulation || !presentation) return;
  const stats = simulation.stats();
  const renderStarted = performance.now();
  presentation.render(simulation, 0, reducedMotion, encounter?.preview() ?? []);
  performanceReadings.renderMs = performance.now() - renderStarted;
  updateUi(stats, performance.now(), forceUi);
}

function frame(timestamp: number): void {
  if (disposed || !encounter || !simulation || !presentation) return;
  frameRequest = requestAnimationFrame(frame);
  if (isPaused() || encounterIsFrozen()) {
    resetClock();
    input?.cancelRepeats();
    if (isPaused()) renderPausedState(true);
    if (encounterIsFrozen()) renderFrozenState(true);
    return;
  }

  const frameStarted = performance.now();
  if (previousFrameTime === 0) previousFrameTime = timestamp;
  const rawFrameSeconds = Math.max(0, (timestamp - previousFrameTime) / 1000);
  previousFrameTime = timestamp;
  performanceReadings.fps = rawFrameSeconds > 0 ? 1 / rawFrameSeconds : 0;
  const frameSeconds = Math.min(rawFrameSeconds, MAX_FRAME_SECONDS);
  recordDroppedDebt(rawFrameSeconds - frameSeconds);
  accumulator += frameSeconds;
  performanceReadings.cascadeMs = 0;

  let steps = 0;
  while (accumulator >= FIXED_STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
    advanceEncounterStep();
    accumulator -= FIXED_STEP_SECONDS;
    steps += 1;
    if (encounterIsFrozen()) {
      input?.cancelRepeats();
      accumulator = 0;
      break;
    }
  }
  if (accumulator >= FIXED_STEP_SECONDS) {
    const dropped = Math.floor(accumulator / FIXED_STEP_SECONDS);
    performanceReadings.droppedSteps += dropped;
    accumulator -= dropped * FIXED_STEP_SECONDS;
    ui.setStatus(
      `Simulation overloaded: ${performanceReadings.droppedSteps} fixed steps dropped.`,
    );
  }

  const stats = simulation.stats();
  audio.update(stats);
  const renderStarted = performance.now();
  presentation.render(simulation, frameSeconds, reducedMotion, encounter.preview());
  performanceReadings.renderMs = performance.now() - renderStarted;
  updateUi(stats, timestamp);
  performanceReadings.frameMs = performance.now() - frameStarted;
}

function onVisibilityChange(): void {
  hidden = document.hidden;
  if (hidden) deferredReleaseGeneration += 1;
  resetClock();
  input?.cancelRepeats();
  runAudioLifecycle(audio.setHidden(hidden));
  setPaused(userPaused);
  if (!hidden) renderPausedState();
}

function onResize(): void {
  presentation?.resize();
  renderPausedState();
}

function installGestureArm(): void {
  const onGesture = (): void => {
    document.removeEventListener("pointerdown", onGesture, true);
    document.removeEventListener("keydown", onGesture, true);
    requestAudioArm();
  };
  document.addEventListener("pointerdown", onGesture, {
    capture: true,
    once: true,
  });
  document.addEventListener("keydown", onGesture, {
    capture: true,
    once: true,
  });
}


function developerStep(): EncounterStep {
  if (!encounter) throw new Error("Encounter is not ready.");
  const externallyPaused = isPaused();
  if (externallyPaused) run?.setPaused(false);
  try {
    return advanceEncounterStep();
  } finally {
    if (externallyPaused) run?.setPaused(true);
    resetClock();
    renderFrozenState(true);
  }
}


async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  deferredReleaseGeneration += 1;
  encounter?.cancelDrops();
  cancelAnimationFrame(frameRequest);
  window.removeEventListener("resize", onResize);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  input?.destroy();
  placementProbe?.dispose();
  presentation?.dispose();
  run?.dispose();
  ui.destroy();
  delete window.__critpusher;
  await audio.dispose();
}

async function start(): Promise<void> {
  if (audio.support.state === "unavailable") {
    ui.elements.sound.disabled = true;
    ui.elements.sound.textContent = "Sound unavailable";
    ui.elements.sound.title =
      audio.support.reason ?? "WebAudio is unavailable.";
    soundWanted = false;
  } else {
    installGestureArm();
  }

  presentation = await createPresentation(ui.elements.scene);
  run = await createRun(ui.getTuning());
  encounter = run.encounter;
  run.setPaused(isPaused());
  simulation = run.simulation;
  freshWorld();
  syncChutes(chuteX);
  ui.setLoading(false);
  ui.setError(null);
  ui.setStatus("Choose a kit above the cabinet. Combat begins with the opening rain.");
  ui.setRhythm("Choose a kit", false);
  input = bindControls({
    canvas: presentation.canvas,
    dropButton: ui.elements.drop,
    aimInput: ui.elements.aim,
    repeatDelayMs: 180,
    repeatIntervalMs: 33,
    getAim: () => Number(ui.elements.aim.value),
    callbacks: {
      onCanvasPoint: ({ clientX, clientY }) =>
        setAimFromPointer(clientX, clientY),
      onCanvasDrop: ({ clientX, clientY }) => {
        setAimFromPointer(clientX, clientY);
        drop();
      },
      onDrop: () => drop(),
      onAim: setAim,
      onPause: () => setPaused(!userPaused),
      onReset: () => {
        try { reset(); }
        catch (error) { ui.setError(errorMessage(error)); }
      },
    },
  });
  window.addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener(
    "pagehide",
    () => void dispose().catch((error) => console.error(error)),
    { once: true },
  );
  if (import.meta.env.DEV) exposeDevApi(run, {
    paused: isPaused, chutes: () => chuteSettings, performance: performanceReadings,
    reset, setPaused, step: developerStep, drop, chooseStarter, purchase, continueRun,
  });
  presentation.resize();
  frameRequest = requestAnimationFrame(frame);
}

void start().catch((error: unknown) => {
  cancelAnimationFrame(frameRequest);
  presentation?.dispose();
  run?.dispose();
  ui.setLoading(false);
  ui.setError(`Critpusher could not start: ${errorMessage(error)}`);
  ui.setStatus("Startup failed. Reload after addressing the error above.");
  ui.setRhythm("Unavailable", false);
  ui.elements.aim.disabled = true;
  ui.elements.drop.disabled = true;
  ui.elements.pause.disabled = true;
  ui.elements.restart.disabled = true;
  ui.elements.applyReset.disabled = true;
  ui.elements.controlHint.textContent = "Reload after resolving the startup error.";
  console.error(error);
});
