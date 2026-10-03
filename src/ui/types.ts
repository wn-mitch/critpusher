import type { ChuteSettings } from "../chutes";
import type { SimulationStats, Tuning } from "../contracts";
import type {
  CombatStepResult,
  EncounterSnapshot,
  FeedTray,
} from "../combat/types";
import type { PurchasePreview, PurchaseRequest, PurchaseResult, RunSnapshot, StarterId } from "../run/types";
export type LiveTuningKey =
  "coinWeight" | "friction" | "stroke" | "period" | "dropHeight";
export type ResetTuningKey =
  | "seed"
  | "density"
  | "radius"
  | "thickness"
  | "shelfFront";
export type TuningKey = LiveTuningKey | ResetTuningKey;
export type TuningPatch = Partial<Tuning>;

export interface AppUiElements {
  root: HTMLElement;
  pause: HTMLButtonElement;
  sound: HTMLButtonElement;
  tuningToggle: HTMLButtonElement;
  restart: HTMLButtonElement;
  scene: HTMLElement;
  collected: HTMLElement;
  active: HTMLElement;
  feedback: HTMLElement;
  loading: HTMLElement;
  status: HTMLElement;
  error: HTMLElement;
  aim: HTMLInputElement;
  drop: HTMLButtonElement;
  rhythm: HTMLElement;
  controlHint: HTMLElement;
  tuningPanel: HTMLElement;
  applyReset: HTMLButtonElement;
  reducedMotion: HTMLInputElement;
  volume: HTMLInputElement;
  metrics: HTMLElement;
  playerHp: HTMLElement;
  playerHpBar: HTMLElement;
  enemyHp: HTMLElement;
  enemyHpBar: HTMLElement;
  enemyRoster: HTMLElement;
  currency: HTMLElement;
  lifecycle: HTMLElement;
  combatCues: HTMLElement;
  tuningInputs: Readonly<Record<TuningKey, HTMLInputElement>>;
  tuningNumbers: Readonly<Record<TuningKey, HTMLInputElement>>;
  densityPresets: readonly HTMLButtonElement[];
}

export interface AppUiCallbacks {
  onPauseChange?: (paused: boolean) => void;
  onSoundChange?: (enabled: boolean) => void;
  onTuningPanelChange?: (open: boolean) => void;
  onRestart?: (tuning?: Tuning) => void;
  onChooseStarter?: (id: StarterId) => boolean;
  onPreviewPurchase?: (request: PurchaseRequest) => PurchasePreview;
  onPurchase?: (request: PurchaseRequest) => PurchaseResult;
  onContinueRun?: () => boolean;
  onLiveTuningChange?: (patch: TuningPatch) => void;
  onResetTuningChange?: (patch: TuningPatch) => void;
  onReducedMotionChange?: (reduced: boolean) => void;
  onVolumeChange?: (volume: number) => void;
  onAimChange?: (aim: number) => void;
  onDrop?: () => void;
  onDensityPreset?: (density: number) => void;
  onChuteSettingsChange?: (settings: ChuteSettings) => void;
}

export interface AppUiOptions {
  initialTuning?: Partial<Tuning>;
  callbacks?: AppUiCallbacks;
}

export interface MetricsSnapshot {
  fps?: number;
  renderMs?: number;
  frameMs?: number;
  cascadeMs?: number;
  droppedSteps?: number;
}

export interface AppUi {
  readonly elements: AppUiElements;
  readonly callbacks: AppUiCallbacks;
  getTuning(): Tuning;
  getLiveTuning(): Pick<Tuning, LiveTuningKey>;
  getResetTuning(): Pick<Tuning, ResetTuningKey>;
  getChuteSettings(): ChuteSettings;
  setTuning(tuning: Partial<Tuning>): void;
  setChuteSettings(settings: ChuteSettings, radius: number): void;
  updateStats(
    stats: Pick<SimulationStats, "active" | "collected">,
  ): void;
  updateMetrics(stats: SimulationStats, metrics?: MetricsSnapshot): void;
  updateEncounter(snapshot: EncounterSnapshot, trays: readonly FeedTray[]): void;
  updateRun(snapshot: RunSnapshot): void;
  showCombat(batch: CombatStepResult): void;
  setFeedback(message: string): void;
  setRhythm(label: string, active?: boolean): void;
  setStatus(message: string): void;
  setLoading(loading: boolean, message?: string): void;
  setError(error: string | null): void;
  setPaused(paused: boolean): void;
  setSoundEnabled(enabled: boolean): void;
  setReducedMotion(reduced: boolean): void;
  setVolume(volume: number): void;
  setTuningPanelOpen(open: boolean): void;
  destroy(): void;
}

export interface PointerPoint {
  clientX: number;
  clientY: number;
}

export interface InputCallbacks {
  onCanvasPoint?: (point: PointerPoint) => void;
  onCanvasDrop?: (point: PointerPoint) => void;
  onDrop?: () => void;
  onAim?: (aim: number) => void;
  onPause?: () => void;
  onReset?: () => void;
}

export interface InputControllerOptions {
  canvas: HTMLElement;
  dropButton: HTMLButtonElement;
  aimInput?: HTMLInputElement;
  callbacks?: InputCallbacks;
  getAim?: () => number;
  repeatDelayMs?: number;
  repeatIntervalMs?: number;
  aimStep?: number;
}

export interface InputController {
  destroy(): void;
  cancelRepeats(): void;
}
