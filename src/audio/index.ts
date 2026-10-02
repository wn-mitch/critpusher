import type { CollectionEvent, SimulationStats } from "../contracts";
import type { CollectionBurstUpdate } from "../feedback/cascade";

export type AudioSupportState = "supported" | "unavailable";

export interface AudioSupport {
  readonly state: AudioSupportState;
  readonly reason: string | null;
}

export class AudioUnavailableError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AudioUnavailableError";
    this.cause = cause;
  }
}

export interface AudioEngine {
  readonly support: AudioSupport;
  readonly armed: boolean;
  readonly muted: boolean;
  readonly volume: number;
  /** Creates/resumes WebAudio. Call from a user gesture; it never runs at startup. */
  arm(): Promise<void>;
  /** Resumes only when armed, unpaused, and visible. */
  resume(): Promise<void>;
  pause(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setHidden(hidden: boolean): Promise<void>;
  setVisibility(visible: boolean): Promise<void>;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  /** Updates the motor sound from the latest simulation frame. */
  update(stats: Readonly<SimulationStats>): void;
  /** Aggregates raw collection events into a bounded clink; a burst update enables payout cues. */
  collect(
    events: readonly CollectionEvent[],
    burst?: CollectionBurstUpdate,
  ): void;
  /** Clears transient feedback and simulation-derived timing without changing sound settings. */
  reset(): void;
  /** Plays the sound of a newly released coin, after arm(). */
  release(): void;
  /** Stops every voice and closes the context. */
  dispose(): Promise<void>;
}

interface AudioContextConstructor {
  new (): AudioContext;
}

type VoiceCleanup = () => void;
type TimerHandle = number;

const MAX_TRANSIENT_VOICES = 8;
const COLLECTION_AGGREGATION_MS = 55;
const COLLECTION_PAYOUT_COOLDOWN_MS = 140;
const COLLECTION_PAYOUT_THRESHOLDS = [1, 2, 4, 8, 16] as const;
const MOTOR_FADE_SECONDS = 0.025;
const TRANSIENT_SECONDS = 0.45;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  if (typeof scope.AudioContext === "function") {
    return scope.AudioContext as unknown as AudioContextConstructor;
  }
  if (typeof scope.webkitAudioContext === "function") {
    return scope.webkitAudioContext;
  }
  return undefined;
}

function normalizePhase(phase: number, time: number): number {
  const value = finiteOr(phase, finiteOr(time, 0));
  // Simulation phases are normally cycles in [0, 1]. Also accept radians so
  // the motor remains useful if a simulation implementation exposes radians.
  const cycles = Math.abs(value) <= 1.000001 ? value : value / (Math.PI * 2);
  return ((cycles % 1) + 1) % 1;
}

function collectionTier(total: number): number {
  let tier = -1;
  for (let index = 0; index < COLLECTION_PAYOUT_THRESHOLDS.length; index += 1) {
    if (total < COLLECTION_PAYOUT_THRESHOLDS[index]!) break;
    tier = index;
  }
  return tier;
}

function collectionPayoutIntensity(tier: number): number {
  return clamp(0.46 + tier * 0.11, 0.46, 0.9);
}

export function createAudioEngine(): AudioEngine {
  const constructor = audioContextConstructor();
  const support: AudioSupport = constructor
    ? { state: "supported", reason: null }
    : {
        state: "unavailable",
        reason:
          "WebAudio is unavailable in this browser. Sound can be enabled in a browser with AudioContext support.",
      };

  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let motorGain: GainNode | undefined;
  let motorOscillator: OscillatorNode | undefined;
  let motorHarmonic: OscillatorNode | undefined;
  let motorStarted = false;
  let armed = false;
  let muted = false;
  let volume = 0.8;
  let paused = false;
  let hidden = false;
  let disposed = false;
  let lastStats: Readonly<SimulationStats> | undefined;
  let lastPusherZ: number | undefined;
  let lastStatsTime: number | undefined;
  let aggregateTimer: TimerHandle | undefined;
  let pendingCollected = 0;
  let pendingOther = 0;
  let activeBurstId: number | undefined;
  let highestBurstTier = -1;
  let pendingPayoutTier: number | undefined;
  let lastPayoutAt: number | undefined;
  let activeVoices = 0;
  const voiceCleanups = new Set<VoiceCleanup>();
  let disposePromise: Promise<void> | undefined;
  const clearAggregation = (): void => {
    if (aggregateTimer !== undefined) {
      globalThis.clearTimeout(aggregateTimer);
      aggregateTimer = undefined;
    }
    pendingCollected = 0;
    pendingOther = 0;
    pendingPayoutTier = undefined;
    lastPayoutAt = undefined;
  };

  const isAllowed = (): boolean => armed && !paused && !hidden && !disposed;

  const setMasterLevel = (atTime?: number): void => {
    if (!master || !context) return;
    const target = muted ? 0 : volume;
    const now = atTime ?? context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(target, now, 0.012);
  };

  const disconnect = (node: AudioNode | undefined): void => {
    node?.disconnect();
  };

  const stopMotor = (): void => {
    if (!motorStarted) return;
    motorStarted = false;
    const oscillator = motorOscillator;
    const harmonic = motorHarmonic;
    motorOscillator = undefined;
    motorHarmonic = undefined;
    if (motorGain && context) {
      const now = context.currentTime;
      motorGain.gain.cancelScheduledValues(now);
      motorGain.gain.setTargetAtTime(0, now, MOTOR_FADE_SECONDS);
    }
    oscillator?.stop();
    harmonic?.stop();
    disconnect(oscillator);
    disconnect(harmonic);
    disconnect(motorGain);
    motorGain = undefined;
  };

  const stopVoices = (): void => {
    const cleanups = [...voiceCleanups];
    for (const cleanup of cleanups) cleanup();
    voiceCleanups.clear();
    clearAggregation();
  };

  const ensureContext = async (): Promise<AudioContext> => {
    if (disposed) throw new Error("Audio engine has been disposed.");
    if (!constructor) {
      throw new AudioUnavailableError(
        support.reason ?? "WebAudio is unavailable.",
      );
    }
    if (context) return context;
    let created: AudioContext;
    try {
      created = new constructor();
    } catch (error) {
      throw new AudioUnavailableError(
        `Unable to start WebAudio. Allow audio for this page or use a browser with AudioContext support. ${describeError(error)}`,
        error,
      );
    }
    context = created;
    try {
      const output = created.createGain();
      output.gain.value = 0;
      output.connect(created.destination);
      master = output;
      setMasterLevel(created.currentTime);
    } catch (error) {
      context = undefined;
      master = undefined;
      try {
        await created.close();
      } catch (closeError) {
        throw new AudioUnavailableError(
          `Unable to initialize WebAudio output (${describeError(error)}); cleanup also failed (${describeError(closeError)}).`,
          closeError,
        );
      }
      throw new AudioUnavailableError(
        `Unable to initialize WebAudio output. ${describeError(error)}`,
        error,
      );
    }
    return created;
  };

  const startMotor = (): void => {
    if (!context || !master || motorStarted || !isAllowed()) return;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(master);
    const oscillator = context.createOscillator();
    oscillator.type = "sawtooth";
    oscillator.frequency.value = 48;
    oscillator.connect(gain);
    const harmonic = context.createOscillator();
    harmonic.type = "triangle";
    harmonic.frequency.value = 96;
    harmonic.connect(gain);
    motorGain = gain;
    motorOscillator = oscillator;
    motorHarmonic = harmonic;
    motorStarted = true;
    oscillator.start(now);
    harmonic.start(now);
  };

  const startVoice = (kind: "clink" | "payout", intensity: number): void => {
    if (
      !context ||
      !master ||
      !isAllowed() ||
      activeVoices >= MAX_TRANSIENT_VOICES
    )
      return;
    const now = context.currentTime;
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    const oscillator = context.createOscillator();
    const harmonic = kind === "payout" ? context.createOscillator() : undefined;
    const level = clamp(intensity, 0.05, 1);
    const duration = kind === "clink" ? 0.16 : TRANSIENT_SECONDS;
    const end = now + duration;
    gain.gain.setValueAtTime(0.0001, now);
    if (kind === "clink") {
      gain.gain.exponentialRampToValueAtTime(0.1 * level, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(1450 + 500 * level, now);
      oscillator.frequency.exponentialRampToValueAtTime(480, end);
      filter.type = "highpass";
      filter.frequency.value = 380;
      filter.Q.value = 1.2;
    } else {
      gain.gain.exponentialRampToValueAtTime(0.12 * level, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(560 + 170 * level, now);
      oscillator.frequency.exponentialRampToValueAtTime(400 + 110 * level, end);
      harmonic?.start(now);
      if (harmonic) {
        harmonic.type = "sine";
        harmonic.frequency.setValueAtTime(oscillator.frequency.value * 2, now);
        harmonic.connect(gain);
      }
      filter.type = "lowpass";
      filter.frequency.value = 2400;
      filter.Q.value = 0.8;
    }
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    oscillator.start(now);
    activeVoices += 1;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      globalThis.clearTimeout(timer);
      voiceCleanups.delete(cleanup);
      activeVoices = Math.max(0, activeVoices - 1);
      oscillator.stop();
      harmonic?.stop();
      disconnect(oscillator);
      disconnect(harmonic);
      disconnect(filter);
      disconnect(gain);
    };
    voiceCleanups.add(cleanup);
    const timer = globalThis.setTimeout(
      cleanup,
      Math.ceil(duration * 1000) + 30,
    ) as unknown as TimerHandle;
  };

  const flushCollection = (): void => {
    aggregateTimer = undefined;
    const collected = pendingCollected;
    const other = pendingOther;
    const payoutTier = pendingPayoutTier;
    pendingCollected = 0;
    pendingOther = 0;
    pendingPayoutTier = undefined;
    if (!isAllowed()) return;
    const total = collected + other;
    if (total > 0) startVoice("clink", clamp(0.35 + total / 20, 0.35, 1));
    if (payoutTier === undefined) return;

    const now = performance.now();
    const elapsed =
      lastPayoutAt === undefined
        ? COLLECTION_PAYOUT_COOLDOWN_MS
        : now - lastPayoutAt;
    if (lastPayoutAt !== undefined && elapsed < COLLECTION_PAYOUT_COOLDOWN_MS) {
      pendingPayoutTier = payoutTier;
      aggregateTimer = globalThis.setTimeout(
        flushCollection,
        COLLECTION_PAYOUT_COOLDOWN_MS - elapsed,
      ) as unknown as TimerHandle;
      return;
    }
    lastPayoutAt = now;
    startVoice("payout", collectionPayoutIntensity(payoutTier));
  };

  const scheduleCollectionFlush = (): void => {
    if (aggregateTimer !== undefined) return;
    aggregateTimer = globalThis.setTimeout(
      flushCollection,
      COLLECTION_AGGREGATION_MS,
    ) as unknown as TimerHandle;
  };

  const arm = async (): Promise<void> => {
    if (disposed) throw new Error("Audio engine has been disposed.");
    if (armed) {
      await resume();
      return;
    }
    const current = await ensureContext();
    try {
      await current.resume();
    } catch (error) {
      context = undefined;
      master = undefined;
      try {
        await current.close();
      } catch (closeError) {
        throw new AudioUnavailableError(
          `Unable to start WebAudio (${describeError(error)}); cleanup also failed (${describeError(closeError)}).`,
          closeError,
        );
      }
      throw new AudioUnavailableError(
        `Unable to start WebAudio. Check browser sound permissions and try again. ${describeError(error)}`,
        error,
      );
    }
    armed = true;
    setMasterLevel();
    if (paused || hidden) {
      await current.suspend();
    } else if (lastStats) {
      update(lastStats);
    }
  };

  const resume = async (): Promise<void> => {
    if (disposed || !armed || paused || hidden) return;
    if (!context)
      throw new Error("Audio engine is armed without an AudioContext.");
    await context.resume();
    setMasterLevel();
    if (lastStats) update(lastStats);
  };

  const pause = async (): Promise<void> => {
    paused = true;
    stopMotor();
    stopVoices();
    if (context && armed && context.state !== "closed") await context.suspend();
  };

  const setPaused = async (value: boolean): Promise<void> => {
    if (value) {
      await pause();
    } else {
      paused = false;
      await resume();
    }
  };

  const setHidden = async (value: boolean): Promise<void> => {
    hidden = value;
    if (value) {
      stopMotor();
      stopVoices();
      if (context && armed && context.state !== "closed")
        await context.suspend();
    } else {
      await resume();
    }
  };

  const update = (stats: Readonly<SimulationStats>): void => {
    lastStats = stats;
    if (!isAllowed() || !context || !master) return;
    startMotor();
    if (!motorGain || !motorOscillator || !motorHarmonic) return;
    const phase = normalizePhase(stats.phase, stats.time);
    const previousZ = lastPusherZ ?? stats.pusherZ;
    const previousTime = lastStatsTime ?? stats.time;
    const elapsed = Math.max(
      1 / 240,
      finiteOr(stats.time, previousTime) - previousTime,
    );
    const travelSpeed = clamp(
      Math.abs(finiteOr(stats.pusherZ, previousZ) - previousZ) / elapsed / 8,
      0,
      1,
    );
    const phaseMotion = Math.abs(Math.sin(phase * Math.PI * 2));
    const motion = clamp(Math.max(travelSpeed, phaseMotion * 0.72), 0, 1);
    const now = context.currentTime;
    motorGain.gain.setTargetAtTime(0.008 + motion * 0.045, now, 0.03);
    motorOscillator.frequency.setTargetAtTime(43 + motion * 19, now, 0.04);
    motorHarmonic.frequency.setTargetAtTime(86 + motion * 38, now, 0.04);
    lastPusherZ = finiteOr(stats.pusherZ, previousZ);
    lastStatsTime = finiteOr(stats.time, previousTime);
  };

  const collect = (
    events: readonly CollectionEvent[],
    burst?: CollectionBurstUpdate,
  ): void => {
    if (!isAllowed()) return;
    let collected = 0;
    for (const event of events) {
      if (event.kind === "collected") {
        pendingCollected += 1;
        collected += 1;
      } else {
        pendingOther += 1;
      }
    }

    if (
      collected > 0 &&
      burst &&
      Number.isFinite(burst.burstId) &&
      Number.isFinite(burst.total) &&
      Number.isFinite(burst.added) &&
      burst.total > 0 &&
      burst.added > 0
    ) {
      if (activeBurstId !== burst.burstId) {
        activeBurstId = burst.burstId;
        highestBurstTier = -1;
        pendingPayoutTier = undefined;
      }
      const tier = collectionTier(burst.total);
      if (tier > highestBurstTier) {
        highestBurstTier = tier;
        pendingPayoutTier = tier;
      }
    }

    if (events.length > 0) scheduleCollectionFlush();
  };

  const reset = (): void => {
    stopMotor();
    stopVoices();
    lastStats = undefined;
    lastPusherZ = undefined;
    lastStatsTime = undefined;
    activeBurstId = undefined;
    highestBurstTier = -1;
    pendingPayoutTier = undefined;
    lastPayoutAt = undefined;
  };

  const release = (): void => {
    if (isAllowed()) startVoice("clink", 0.55);
  };

  const setMuted = (value: boolean): void => {
    muted = value;
    if (context) setMasterLevel();
  };

  const setVolume = (value: number): void => {
    if (!Number.isFinite(value))
      throw new RangeError(
        "Audio volume must be a finite number between 0 and 1.",
      );
    volume = clamp(value, 0, 1);
    if (context) setMasterLevel();
  };

  const dispose = async (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    armed = false;
    stopMotor();
    stopVoices();
    const current = context;
    context = undefined;
    master = undefined;
    disposePromise =
      current && current.state !== "closed"
        ? current.close()
        : Promise.resolve();
    await disposePromise;
  };

  return {
    support,
    get armed() {
      return armed;
    },
    get muted() {
      return muted;
    },
    get volume() {
      return volume;
    },
    arm,
    resume,
    pause,
    setPaused,
    setHidden,
    setVisibility: (visible) => setHidden(!visible),
    setMuted,
    setVolume,
    update,
    collect,
    reset,
    release,
    dispose,
  };
}

export default createAudioEngine;
