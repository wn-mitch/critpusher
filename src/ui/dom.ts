import { createChuteControls } from "./chutes";
import type { SimulationStats, Tuning } from "../contracts";
import { DEFAULT_TUNING, sanitizeTuning } from "../simulation/config";
import { renderMetrics } from "./metrics";
import type {
  AppUi,
  AppUiCallbacks,
  AppUiElements,
  AppUiOptions,
  LiveTuningKey,
  MetricsSnapshot,
  ResetTuningKey,
  TuningKey,
} from "./types";

const LIVE_KEYS: readonly LiveTuningKey[] = [
  "coinWeight",
  "friction",
  "stroke",
  "period",
  "dropHeight",
];
const RESET_KEYS: readonly ResetTuningKey[] = [
  "seed",
  "density",
  "radius",
  "thickness",
  "shelfFront",
  "openingEnemyPercent",
  "openingDudPercent",
];
const FIELD_LABELS: Record<TuningKey, string> = {
  seed: "Seed",
  density: "Pile density",
  radius: "Coin radius",
  thickness: "Coin thickness",
  shelfFront: "Collection edge depth",
  coinWeight: "Coin weight (×)",
  friction: "Surface friction",
  stroke: "Pusher stroke",
  period: "Pusher period",
  dropHeight: "Drop height",
  openingEnemyPercent: "Opening enemy coins (%)",
  openingDudPercent: "Opening dud coins (%)",
};
const FIELD_LIMITS: Record<
  TuningKey,
  { min: number; max: number; step: number }
> = {
  seed: { min: 0, max: 2147483647, step: 1 },
  density: { min: 1, max: 2000, step: 1 },
  radius: { min: 0.2, max: 0.6, step: 0.01 },
  thickness: { min: 0.05, max: 0.3, step: 0.01 },
  shelfFront: { min: 2.5, max: 4, step: 0.1 },
  coinWeight: { min: 0.1, max: 10, step: 0.1 },
  friction: { min: 0.05, max: 1, step: 0.01 },
  stroke: { min: 0.4, max: 2, step: 0.01 },
  period: { min: 0.75, max: 5, step: 0.01 },
  dropHeight: { min: 1.5, max: 6, step: 0.01 },
  openingEnemyPercent: { min: 0, max: 100, step: 1 },
  openingDudPercent: { min: 0, max: 100, step: 1 },
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(
  id: string,
  label: string,
  className?: string,
): HTMLButtonElement {
  const node = element("button", className);
  node.id = id;
  node.type = "button";
  node.textContent = label;
  return node;
}

function labelledValue(
  label: string,
  id: string,
  value: string,
): HTMLSpanElement {
  const node = element("span", "value-readout");
  node.setAttribute("aria-label", label);
  node.id = id;
  node.textContent = value;
  return node;
}

function setInputValue(input: HTMLInputElement, value: number): void {
  input.value = String(value);
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function createTuningField(
  key: TuningKey,
  tuning: Tuning,
  numbers: Record<TuningKey, HTMLInputElement>,
  ranges: Record<TuningKey, HTMLInputElement>,
  cleanup: Array<() => void>,
): HTMLDivElement {
  const limits = FIELD_LIMITS[key];
  const wrapper = element("div", "tuning-field");
  wrapper.dataset.tuningKey = key;
  const label = element("label");
  label.htmlFor = key;
  label.textContent = FIELD_LABELS[key];
  const value = labelledValue(
    FIELD_LABELS[key],
    `${key}-value`,
    formatNumber(tuning[key]),
  );
  label.append(value);

  const range = element("input");
  range.id = key;
  range.name = key;
  range.type = "range";
  range.min = String(limits.min);
  range.max = String(limits.max);
  range.step = String(limits.step);
  range.value = String(tuning[key]);
  range.setAttribute("aria-label", FIELD_LABELS[key]);
  range.dataset.tuningKind = LIVE_KEYS.includes(key as LiveTuningKey)
    ? "live"
    : "reset";

  const number = element("input");
  number.id = `${key}-input`;
  number.name = key;
  number.type = "number";
  number.min = String(limits.min);
  number.max = String(limits.max);
  number.step = String(limits.step);
  number.value = String(tuning[key]);
  number.inputMode = "decimal";
  number.setAttribute("aria-label", `${FIELD_LABELS[key]} exact value`);
  number.dataset.tuningKind = range.dataset.tuningKind;

  const syncRange = (): void => {
    const next = readNumber(range, tuning[key]);
    setInputValue(number, next);
    value.textContent = formatNumber(next);
  };
  const syncNumber = (): void => {
    const next = readNumber(number, tuning[key]);
    setInputValue(range, next);
    value.textContent = formatNumber(next);
  };
  range.addEventListener("input", syncRange);
  number.addEventListener("input", syncNumber);
  cleanup.push(() => range.removeEventListener("input", syncRange));
  cleanup.push(() => number.removeEventListener("input", syncNumber));

  numbers[key] = number;
  ranges[key] = range;
  wrapper.append(label, range, number);
  return wrapper;
}

function toTuning(partial: Partial<Tuning>, current: Tuning): Tuning {
  return { ...current, ...partial };
}

export function createAppUi(
  root: HTMLElement,
  options: AppUiOptions = {},
): AppUi {
  const callbacks: AppUiCallbacks = options.callbacks ?? {};
  const tuning = sanitizeTuning(DEFAULT_TUNING, options.initialTuning);
  const cleanup: Array<() => void> = [];
  root.replaceChildren();
  root.className = "app-shell";

  const header = element("header", "topbar");
  const brandLine = element("div", "brand-line");
  const brand = element("div", "brand");
  brand.textContent = "CRITPUSHER";
  brand.setAttribute("aria-label", "Critpusher");
  const mode = element("div", "mode-label");
  mode.textContent = "PHYSICS LAB";
  brandLine.append(brand, mode);
  const toolbar = element("nav", "toolbar");
  toolbar.setAttribute("aria-label", "Machine controls");
  const pause = button("pause", "Pause");
  const sound = button("sound", "Sound ready");
  const tuningToggle = button("tuning-toggle", "Tuning");
  const restart = button("restart", "Reset");
  sound.setAttribute("aria-pressed", "false");
  pause.setAttribute("aria-pressed", "false");
  toolbar.append(pause, sound, tuningToggle, restart);
  header.append(brandLine, toolbar);

  const main = element("main", "game-layout");
  const stage = element("section", "machine-stage");
  stage.setAttribute("aria-label", "Coin pusher machine");
  const scene = element("div");
  scene.id = "scene";
  scene.tabIndex = 0;
  scene.setAttribute(
    "aria-label",
    "Coin pusher play area. Use the drop button or Space to drop a coin.",
  );
  const hud = element("div", "stage-hud");
  const collected = element("span");
  collected.id = "collected";
  collected.textContent = "0";
  const collectedLabel = element("span", "hud-stat");
  collectedLabel.append("Collected ", collected);
  const allyCollected = element("span");
  allyCollected.id = "ally-collected";
  allyCollected.textContent = "0";
  const allyLabel = element("span", "hud-stat");
  allyLabel.append("Ally caught ", allyCollected);
  const enemyCollected = element("span");
  enemyCollected.id = "enemy-collected";
  enemyCollected.textContent = "0";
  const enemyLabel = element("span", "hud-stat");
  enemyLabel.append("Enemy caught ", enemyCollected);
  const dudCollected = element("span");
  dudCollected.id = "dud-collected";
  dudCollected.textContent = "0";
  const dudLabel = element("span", "hud-stat");
  dudLabel.append("Duds caught ", dudCollected);
  const active = element("span");
  active.id = "active";
  active.textContent = "0";
  const activeLabel = element("span", "hud-stat");
  activeLabel.append("In play ", active);
  const feedback = element("div");
  feedback.id = "feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.setAttribute("aria-atomic", "true");
  hud.append(
    collectedLabel,
    allyLabel,
    enemyLabel,
    dudLabel,
    activeLabel,
    feedback,
  );
  const loading = element("div", "loading-state");
  loading.id = "loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  loading.textContent = "Loading physics lab…";
  const error = element("div", "error-state");
  error.id = "error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const status = element("p", "status");
  status.id = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Ready when the machine is loaded.";
  stage.append(scene, hud, loading, error, status);

  const footer = element("footer", "play-controls");
  const aimControl = element("div", "aim-control");
  const aimLabel = element("label");
  aimLabel.htmlFor = "aim";
  aimLabel.textContent = "Chute position";
  const aim = element("input");
  aim.id = "aim";
  aim.name = "aim";
  aim.type = "range";
  aim.min = "-1";
  aim.max = "1";
  aim.step = "0.01";
  aim.value = "0";
  aim.setAttribute("aria-label", "Chute position");
  aimControl.append(aimLabel, aim);
  const drop = button("drop", "Drop coin", "primary");
  const hint = element("span", "key-hint");
  hint.textContent = "Space";
  hint.setAttribute("aria-hidden", "true");
  drop.append(" ", hint);
  const rhythm = element("div", "rhythm");
  rhythm.id = "rhythm";
  rhythm.setAttribute("role", "status");
  rhythm.setAttribute("aria-live", "polite");
  rhythm.textContent = "Ready";
  const controlHint = element("p", "control-hint");
  controlHint.textContent =
    "Arrow keys aim • Space drops • P pauses • R resets";
  footer.append(aimControl, drop, rhythm, controlHint);

  const aside = element("aside", "tuning-panel");
  aside.id = "tuning-panel";
  aside.hidden = true;
  aside.setAttribute("aria-label", "Tuning controls");
  const tuningHeading = element("h2");
  tuningHeading.textContent = "Tuning";
  const chuteControls = createChuteControls(
    tuning.radius,
    callbacks.onChuteSettingsChange,
  );
  const chuteGroup = chuteControls.group;
  cleanup.push(chuteControls.destroy);
  const liveGroup = element("fieldset", "tuning-group");
  const liveLegend = element("legend");
  liveLegend.textContent = "Live tuning";
  liveGroup.append(liveLegend);
  const resetGroup = element("fieldset", "tuning-group");
  const resetLegend = element("legend");
  resetLegend.textContent = "Reset-required tuning";
  const resetHelp = element("p", "chute-help");
  const updateOpeningMixHelp = (): void => {
    resetHelp.textContent = `On reseed: ${100 - tuning.openingEnemyPercent - tuning.openingDudPercent}% ally, ${tuning.openingEnemyPercent}% enemy, ${tuning.openingDudPercent}% duds. Gray duds count for neither side.`;
  };
  updateOpeningMixHelp();
  resetGroup.append(resetLegend, resetHelp);
  const ranges = {} as Record<TuningKey, HTMLInputElement>;
  const numbers = {} as Record<TuningKey, HTMLInputElement>;
  for (const key of LIVE_KEYS)
    liveGroup.append(createTuningField(key, tuning, numbers, ranges, cleanup));
  for (const key of RESET_KEYS)
    resetGroup.append(createTuningField(key, tuning, numbers, ranges, cleanup));
  const presetGroup = element("div", "density-presets");
  const presetLabel = element("p");
  presetLabel.textContent = "Density presets";
  presetGroup.append(presetLabel);
  const densityPresets: HTMLButtonElement[] = [];
  for (const density of [150, 300, 500, 1000]) {
    const preset = button(
      `density-${density}`,
      String(density),
      "density-preset",
    );
    preset.dataset.density = String(density);
    densityPresets.push(preset);
    presetGroup.append(preset);
  }
  const applyReset = button("apply-reset", "Reseed pile", "primary");
  const accessibility = element("div", "accessibility-controls");
  const motionLabel = element("label");
  const reducedMotion = element("input");
  reducedMotion.id = "reduced-motion";
  reducedMotion.type = "checkbox";
  motionLabel.append(reducedMotion, " Reduced motion");
  const volumeLabel = element("label");
  volumeLabel.htmlFor = "volume";
  volumeLabel.textContent = "Volume";
  const volume = element("input");
  volume.id = "volume";
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = "0.75";
  volume.setAttribute("aria-label", "Volume");
  accessibility.append(motionLabel, volumeLabel, volume);
  const metrics = element("section", "metrics");
  metrics.id = "metrics";
  metrics.setAttribute("aria-label", "Machine metrics");
  aside.append(
    tuningHeading,
    chuteGroup,
    liveGroup,
    resetGroup,
    presetGroup,
    applyReset,
    accessibility,
    metrics,
  );

  main.append(stage, footer, aside);
  root.append(header, main);

  const elements: AppUiElements = {
    root,
    pause,
    sound,
    tuningToggle,
    restart,
    scene,
    collected,
    allyCollected,
    enemyCollected,
    dudCollected,
    active,
    feedback,
    loading,
    status,
    error,
    aim,
    drop,
    rhythm,
    controlHint,
    tuningPanel: aside,
    applyReset,
    reducedMotion,
    volume,
    metrics,
    tuningInputs: ranges,
    tuningNumbers: numbers,
    densityPresets,
  };

  const syncTuningControls = (): void => {
    for (const key of [...LIVE_KEYS, ...RESET_KEYS]) {
      const next = tuning[key];
      setInputValue(ranges[key], next);
      setInputValue(numbers[key], next);
      const readout = document.getElementById(`${key}-value`);
      if (readout) readout.textContent = formatNumber(next);
    }
    updateOpeningMixHelp();
  };
  const sanitizeTuningField = (key: TuningKey): void => {
    const next = readNumber(numbers[key], tuning[key]);
    Object.assign(tuning, sanitizeTuning(tuning, { [key]: next }));
    syncTuningControls();
  };
  const emitTuning = (key: TuningKey): void => {
    sanitizeTuningField(key);
    if (LIVE_KEYS.includes(key as LiveTuningKey)) {
      callbacks.onLiveTuningChange?.({ [key]: tuning[key] });
      return;
    }
    const patch =
      key === "openingEnemyPercent" || key === "openingDudPercent"
        ? {
            openingEnemyPercent: tuning.openingEnemyPercent,
            openingDudPercent: tuning.openingDudPercent,
          }
        : { [key]: tuning[key] };
    callbacks.onResetTuningChange?.(patch);
  };
  for (const key of [...LIVE_KEYS, ...RESET_KEYS]) {
    const number = numbers[key];
    const range = ranges[key];
    const live = LIVE_KEYS.includes(key as LiveTuningKey);
    const onInput = (): void => {
      sanitizeTuningField(key);
      if (live) emitTuning(key);
    };
    const onChange = (): void => emitTuning(key);
    range.addEventListener("input", onInput);
    number.addEventListener("change", onChange);
    range.addEventListener("change", onChange);
    cleanup.push(
      () => range.removeEventListener("input", onInput),
      () => number.removeEventListener("change", onChange),
      () => range.removeEventListener("change", onChange),
    );
  }
  const onPause = (): void => {
    const paused = pause.getAttribute("aria-pressed") !== "true";
    setPaused(paused);
    callbacks.onPauseChange?.(paused);
  };
  const onSound = (): void => {
    const enabled = sound.getAttribute("aria-pressed") !== "true";
    setSoundEnabled(enabled);
    callbacks.onSoundChange?.(enabled);
  };
  const onTuningToggle = (): void => {
    const open = aside.hidden !== false;
    setTuningPanelOpen(open);
    callbacks.onTuningPanelChange?.(open);
  };
  const onRestart = (): void => callbacks.onRestart?.({ ...tuning });
  const onApplyReset = (): void => callbacks.onRestart?.({ ...tuning });
  const onAim = (): void => callbacks.onAimChange?.(Number(aim.value));
  const onMotion = (): void =>
    callbacks.onReducedMotionChange?.(reducedMotion.checked);
  const onVolume = (): void => callbacks.onVolumeChange?.(Number(volume.value));
  const onDrop = (): void => callbacks.onDrop?.();
  pause.addEventListener("click", onPause);
  sound.addEventListener("click", onSound);
  tuningToggle.addEventListener("click", onTuningToggle);
  restart.addEventListener("click", onRestart);
  applyReset.addEventListener("click", onApplyReset);
  aim.addEventListener("input", onAim);
  reducedMotion.addEventListener("change", onMotion);
  volume.addEventListener("input", onVolume);
  drop.addEventListener("click", onDrop);
  cleanup.push(
    () => pause.removeEventListener("click", onPause),
    () => sound.removeEventListener("click", onSound),
    () => tuningToggle.removeEventListener("click", onTuningToggle),
    () => restart.removeEventListener("click", onRestart),
    () => applyReset.removeEventListener("click", onApplyReset),
    () => aim.removeEventListener("input", onAim),
    () => reducedMotion.removeEventListener("change", onMotion),
    () => volume.removeEventListener("input", onVolume),
    () => drop.removeEventListener("click", onDrop),
  );
  for (const preset of densityPresets) {
    const onPreset = (): void => {
      const density = Number(preset.dataset.density);
      setTuning({ density });
      callbacks.onDensityPreset?.(density);
      callbacks.onResetTuningChange?.({ density });
    };
    preset.addEventListener("click", onPreset);
    cleanup.push(() => preset.removeEventListener("click", onPreset));
  }

  function setTuning(next: Partial<Tuning>): void {
    Object.assign(tuning, sanitizeTuning(tuning, next));
    syncTuningControls();
  }
  function setLoading(
    isLoading: boolean,
    message = "Loading physics lab…",
  ): void {
    loading.hidden = !isLoading;
    if (isLoading) loading.textContent = message;
  }
  function setError(message: string | null): void {
    error.hidden = message === null;
    error.textContent = message ?? "";
    if (message !== null) loading.hidden = true;
    root.dataset.state = message === null ? "ready" : "error";
  }
  function setPaused(isPaused: boolean): void {
    pause.setAttribute("aria-pressed", String(isPaused));
    pause.textContent = isPaused ? "Resume" : "Pause";
  }
  function setSoundEnabled(enabled: boolean): void {
    sound.setAttribute("aria-pressed", String(enabled));
    sound.textContent = enabled ? "Sound on" : "Sound off";
  }
  function setReducedMotion(reduced: boolean): void {
    reducedMotion.checked = reduced;
  }
  function setVolume(next: number): void {
    volume.value = String(Math.min(1, Math.max(0, next)));
  }
  function setTuningPanelOpen(open: boolean): void {
    aside.hidden = !open;
    tuningToggle.setAttribute("aria-expanded", String(open));
  }
  function updateStats(
    stats: Pick<
      SimulationStats,
      | "active"
      | "collected"
      | "allyCollected"
      | "enemyCollected"
      | "dudCollected"
    >,
  ): void {
    active.textContent = String(stats.active);
    collected.textContent = String(stats.collected);
    allyCollected.textContent = String(stats.allyCollected);
    enemyCollected.textContent = String(stats.enemyCollected);
    dudCollected.textContent = String(stats.dudCollected);
  }
  function updateMetrics(
    stats: SimulationStats,
    snapshot: MetricsSnapshot = {},
  ): void {
    renderMetrics(metrics, stats, snapshot);
  }
  function destroy(): void {
    for (const dispose of cleanup.splice(0)) dispose();
    root.replaceChildren();
  }

  setTuningPanelOpen(false);
  setLoading(true);
  return {
    elements,
    callbacks,
    getTuning: () => ({ ...tuning }),
    getLiveTuning: () => ({
      coinWeight: tuning.coinWeight,
      friction: tuning.friction,
      stroke: tuning.stroke,
      period: tuning.period,
      dropHeight: tuning.dropHeight,
    }),
    getResetTuning: () => ({
      seed: tuning.seed,
      density: tuning.density,
      radius: tuning.radius,
      thickness: tuning.thickness,
      shelfFront: tuning.shelfFront,
      openingEnemyPercent: tuning.openingEnemyPercent,
      openingDudPercent: tuning.openingDudPercent,
    }),
    getChuteSettings: chuteControls.get,
    setChuteSettings: chuteControls.set,
    setTuning,
    updateStats,
    updateMetrics,
    setFeedback: (message) => {
      feedback.textContent = message;
    },
    setRhythm: (label, isActive = false) => {
      rhythm.textContent = label;
      rhythm.dataset.active = String(isActive);
    },
    setStatus: (message) => {
      status.textContent = message;
    },
    setLoading,
    setError,
    setPaused,
    setSoundEnabled,
    setReducedMotion,
    setVolume,
    setTuningPanelOpen,
    destroy,
  };
}
