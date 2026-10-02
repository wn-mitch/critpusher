import "./style.css";

import type {
  Presentation,
  Simulation,
  SimulationStats,
  Tuning,
} from "./contracts";
import {
  createChuteLayout,
  DEFAULT_CHUTES,
  sanitizeChutes,
  type ChuteSettings,
} from "./chutes";
import { createAudioEngine } from "./audio";
import { createPlacementProbe, type PlacementProbe } from "./experiments/panel";
import { createCollectionBurstTracker } from "./feedback/cascade";
import { createDropSequence } from "./feedback/drop-sequence";
import { createPresentation } from "./presentation";
import { createSimulation, DEFAULT_TUNING } from "./simulation";
import { bindControls, createAppUi, type InputController } from "./ui";

const FIXED_STEP_SECONDS = 1 / 60;
const MAX_STEPS_PER_FRAME = 6;
const MAX_FRAME_SECONDS = 0.25;
const CHUTE_LIMIT = 4.4;
const UI_UPDATE_INTERVAL_MS = 200;

interface PerformanceReadings {
  fps: number;
  renderMs: number;
  frameMs: number;
  cascadeMs: number;
  droppedSteps: number;
}

interface CritpusherSnapshot extends SimulationStats, PerformanceReadings {
  paused: boolean;
  tuning: Tuning;
  chutes: ChuteSettings;
  remainingDrops: number;
}

interface CritpusherDevApi {
  simulation: Simulation;
  snapshot(): CritpusherSnapshot;
  reset(tuning?: Partial<Tuning>): void;
  setPaused(value: boolean): void;
  drop(x?: number): boolean;
}

declare global {
  interface Window {
    __critpusher?: CritpusherDevApi;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Critpusher cannot start because #app is missing.");

const audio = createAudioEngine();
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
let chuteLayout = createChuteLayout(chuteSettings, DEFAULT_TUNING, chuteX);
let releaseLayout = chuteLayout.slice().sort((a, b) => a.x - b.x);
const dropSequence = createDropSequence();
let userPaused = false;
let hidden = document.hidden;
let reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
let soundWanted = true;
let armPromise: Promise<void> | undefined;
let deferredReleaseGeneration = 0;
let lastUiUpdate = 0;
const collectionBursts = createCollectionBurstTracker();
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
    onRestart: (tuning) => reset(tuning),
    onLiveTuningChange: (patch) => {
      if (!simulation) return;
      simulation.configure(patch);
      const { coinWeight, friction, stroke, period, dropHeight, dropRate } =
        simulation.tuning;
      ui.setTuning({
        coinWeight,
        friction,
        stroke,
        period,
        dropHeight,
        dropRate,
      });
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
  if (paused) {
    deferredReleaseGeneration += 1;
    dropSequence.cancel();
  }
  resetClock();
  input?.cancelRepeats();
  ui.setPaused(paused);
  ui.setRhythm(paused ? "Paused" : "Ready", false);
  ui.setStatus(paused ? "Machine paused." : "Machine running.");
  runAudioLifecycle(audio.setPaused(isPaused()));
  renderPausedState(true);
}

function renderPausedState(forceUi = false): void {
  if (!userPaused || hidden || !simulation || !presentation) return;
  const stats = simulation.stats();
  const renderStarted = performance.now();
  presentation.render(simulation, 0, reducedMotion, chuteLayout);
  performanceReadings.renderMs = performance.now() - renderStarted;
  updateUi(stats, performance.now(), forceUi);
}

function syncChutes(requestedX: number): void {
  const tuning = simulation?.tuning ?? DEFAULT_TUNING;
  chuteSettings = sanitizeChutes(chuteSettings, tuning);
  chuteLayout = createChuteLayout(chuteSettings, tuning, requestedX);
  // Left-to-right body insertion keeps playable releases aligned with trials.
  releaseLayout = chuteLayout.slice().sort((a, b) => a.x - b.x);
  chuteX = chuteLayout[0]!.x;
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
  if (!simulation || isPaused() || dropSequence.remaining > 0) return false;
  const tick = Math.round(simulationClock / FIXED_STEP_SECONDS);
  if (!dropSequence.canStart(tick)) {
    ui.setRhythm("Waiting for drop interval", false);
    return false;
  }
  if (x !== chuteX) syncChutes(x);
  return dropSequence.start(
    chuteSettings.dropsPerAction,
    Math.ceil(chuteSettings.dropDelay / FIXED_STEP_SECONDS),
    tick,
    releaseSingle,
  );
}

function releaseSingle(): boolean {
  if (!simulation || isPaused()) return false;
  const accepted = simulation.releaseChutes(releaseLayout) !== null;
  if (accepted) {
    const total = chuteSettings.playerStack + chuteSettings.enemyChutes * 3;
    const queued = dropSequence.remaining - 1;
    ui.setRhythm(
      `${total} coins released${queued > 0 ? `; ${queued} drops queued` : ""}`,
      true,
    );
    if (audio.armed) audio.release();
    else {
      const releaseGeneration = deferredReleaseGeneration;
      void armAudio()
        .then(() => {
          if (releaseGeneration === deferredReleaseGeneration) audio.release();
        })
        .catch(() => {
          // armAudio surfaces the actionable error in the app before rejecting.
        });
    }
  } else {
    ui.setRhythm("Release blocked; sequence stopped", false);
  }
  return accepted;
}

function reset(tuning?: Partial<Tuning>): void {
  if (!simulation) return;
  input?.cancelRepeats();
  dropSequence.cancel();
  simulation.reset(tuning);
  deferredReleaseGeneration += 1;
  collectionBursts.reset();
  simulationClock = 0;
  audio.reset();
  placementProbe?.reset();
  ui.setTuning(simulation.tuning);
  syncChutes(chuteX);
  performanceReadings.droppedSteps = 0;
  performanceReadings.cascadeMs = 0;
  resetClock();
  ui.setFeedback("Pile reseeded.");
  ui.setRhythm("Ready", false);
  ui.setStatus(`Pile ready with ${simulation.tuning.density} coins.`);
  updateUi(simulation.stats(), performance.now(), true);
  renderPausedState();
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
}

function processStepEvents(): void {
  if (!simulation || !presentation) return;
  const events = simulation.drainEvents();
  const burst = collectionBursts.collect(events, simulationClock);
  if (events.length === 0) return;

  const cascadeStarted = performance.now();
  presentation.collect(events, reducedMotion);
  placementProbe?.collect(events);
  audio.collect(events, burst ?? undefined);
  if (burst) {
    ui.setFeedback(
      `${burst.total} coin${burst.total === 1 ? "" : "s"} collected.`,
    );
  }
  performanceReadings.cascadeMs += performance.now() - cascadeStarted;
}

function frame(timestamp: number): void {
  if (disposed || !simulation || !presentation) return;
  frameRequest = requestAnimationFrame(frame);
  if (isPaused()) {
    resetClock();
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
    dropSequence.advance(
      Math.round(simulationClock / FIXED_STEP_SECONDS),
      releaseSingle,
    );
    simulation.step();
    simulationClock += FIXED_STEP_SECONDS;
    processStepEvents();
    accumulator -= FIXED_STEP_SECONDS;
    steps += 1;
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
  presentation.render(simulation, frameSeconds, reducedMotion, chuteLayout);
  performanceReadings.renderMs = performance.now() - renderStarted;
  updateUi(stats, timestamp);
  performanceReadings.frameMs = performance.now() - frameStarted;
}

function onVisibilityChange(): void {
  hidden = document.hidden;
  if (hidden) {
    deferredReleaseGeneration += 1;
    dropSequence.cancel();
  }
  resetClock();
  input?.cancelRepeats();
  runAudioLifecycle(audio.setHidden(hidden));
  if (!hidden) {
    ui.setPaused(userPaused);
    ui.setRhythm(userPaused ? "Paused" : "Ready", false);
    ui.setStatus(userPaused ? "Machine paused." : "Machine running.");
    renderPausedState();
  }
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

function exposeDevApi(currentSimulation: Simulation): void {
  if (!import.meta.env.DEV) return;
  window.__critpusher = {
    simulation: currentSimulation,
    snapshot: () => ({
      ...currentSimulation.stats(),
      paused: isPaused(),
      fps: performanceReadings.fps,
      renderMs: performanceReadings.renderMs,
      frameMs: performanceReadings.frameMs,
      cascadeMs: performanceReadings.cascadeMs,
      droppedSteps: performanceReadings.droppedSteps,
      tuning: { ...currentSimulation.tuning },
      chutes: { ...chuteSettings },
      remainingDrops: dropSequence.remaining,
    }),
    reset,
    setPaused,
    drop,
  };
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  deferredReleaseGeneration += 1;
  dropSequence.cancel();
  cancelAnimationFrame(frameRequest);
  window.removeEventListener("resize", onResize);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  input?.destroy();
  placementProbe?.dispose();
  presentation?.dispose();
  simulation?.dispose();
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

  presentation = createPresentation(ui.elements.scene);
  simulation = await createSimulation(ui.getTuning());
  placementProbe = createPlacementProbe({
    host: ui.elements.tuningPanel,
    simulation,
    presentation,
    onChange: renderPausedState,
  });
  ui.setTuning(simulation.tuning);
  syncChutes(chuteX);
  ui.setLoading(false);
  ui.setError(null);
  ui.setStatus(`Pile ready with ${simulation.tuning.density} coins.`);
  ui.setRhythm("Ready", false);
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
      onReset: () => reset(ui.getTuning()),
    },
  });
  window.addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener(
    "pagehide",
    () => void dispose().catch((error) => console.error(error)),
    { once: true },
  );
  exposeDevApi(simulation);
  presentation.resize();
  frameRequest = requestAnimationFrame(frame);
}

void start().catch((error: unknown) => {
  cancelAnimationFrame(frameRequest);
  ui.setLoading(false);
  ui.setError(`Critpusher could not start: ${errorMessage(error)}`);
  ui.setStatus("Startup failed. Reload after addressing the error above.");
  console.error(error);
});
