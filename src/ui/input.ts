import type {
  InputCallbacks,
  InputController,
  InputControllerOptions,
  PointerPoint,
} from "./types";

const EDITABLE_TAGS = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "BUTTON",
]);

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    EDITABLE_TAGS.has(target.tagName) ||
    target.isContentEditable ||
    target.getAttribute("role") === "textbox"
  );
}

class HoldRepeat {
  private readonly handles = new Map<
    string,
    { timeout: number; interval?: number }
  >();

  start(
    key: string,
    action: () => void,
    delay: number,
    interval: number,
  ): void {
    this.stop(key);
    action();
    const timeout = window.setTimeout(() => {
      const state = this.handles.get(key);
      if (!state) return;
      state.interval = window.setInterval(action, interval);
    }, delay);
    this.handles.set(key, { timeout });
  }

  stop(key: string): void {
    const state = this.handles.get(key);
    if (!state) return;
    window.clearTimeout(state.timeout);
    if (state.interval !== undefined) window.clearInterval(state.interval);
    this.handles.delete(key);
  }

  stopAll(): void {
    for (const key of this.handles.keys()) this.stop(key);
  }
}

function pointFromEvent(event: PointerEvent): PointerPoint {
  return { clientX: event.clientX, clientY: event.clientY };
}

function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Synthetic events and browsers without active capture may reject this.
  }
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  try {
    if (target.hasPointerCapture(pointerId))
      target.releasePointerCapture(pointerId);
  } catch {
    // Pointer cancellation can race with browser capture teardown.
  }
}

export function bindControls(options: InputControllerOptions): InputController {
  const callbacks: InputCallbacks = options.callbacks ?? {};
  const repeats = new HoldRepeat();
  const cleanup: Array<() => void> = [];
  const activePointers = new Set<number>();
  const latestPoints = new Map<number, PointerPoint>();
  const delay = options.repeatDelayMs ?? 220;
  const interval = options.repeatIntervalMs ?? 105;
  const aimStep = options.aimStep ?? 0.08;
  const readAim = (): number => {
    const value = options.getAim?.() ?? Number(options.aimInput?.value ?? 0);
    return Number.isFinite(value) ? value : 0;
  };

  const emitAim = (next: number): void => {
    const clamped = Math.max(-1, Math.min(1, next));
    if (options.aimInput) options.aimInput.value = String(clamped);
    callbacks.onAim?.(clamped);
  };
  const stopPointer = (pointerId: number): void => {
    repeats.stop(`canvas:${pointerId}`);
    repeats.stop(`drop:${pointerId}`);
    activePointers.delete(pointerId);
    latestPoints.delete(pointerId);
  };

  const onCanvasPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    activePointers.add(event.pointerId);
    latestPoints.set(event.pointerId, point);
    callbacks.onCanvasPoint?.(point);
    capturePointer(options.canvas, event.pointerId);
    repeats.start(
      `canvas:${event.pointerId}`,
      () => {
        const latest = latestPoints.get(event.pointerId);
        if (latest) callbacks.onCanvasDrop?.(latest);
      },
      delay,
      interval,
    );
  };
  const onCanvasPointerMove = (event: PointerEvent): void => {
    const point = pointFromEvent(event);
    latestPoints.set(event.pointerId, point);
    callbacks.onCanvasPoint?.(point);
  };
  const onCanvasPointerUp = (event: PointerEvent): void => {
    stopPointer(event.pointerId);
    releasePointer(options.canvas, event.pointerId);
  };
  options.canvas.addEventListener("pointerdown", onCanvasPointerDown);
  options.canvas.addEventListener("pointermove", onCanvasPointerMove);
  options.canvas.addEventListener("pointerup", onCanvasPointerUp);
  options.canvas.addEventListener("pointercancel", onCanvasPointerUp);
  options.canvas.addEventListener("lostpointercapture", onCanvasPointerUp);
  cleanup.push(
    () =>
      options.canvas.removeEventListener("pointerdown", onCanvasPointerDown),
    () =>
      options.canvas.removeEventListener("pointermove", onCanvasPointerMove),
    () => options.canvas.removeEventListener("pointerup", onCanvasPointerUp),
    () =>
      options.canvas.removeEventListener("pointercancel", onCanvasPointerUp),
    () =>
      options.canvas.removeEventListener(
        "lostpointercapture",
        onCanvasPointerUp,
      ),
  );

  const onDropPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const key = `drop:${event.pointerId}`;
    capturePointer(options.dropButton, event.pointerId);
    repeats.start(key, () => callbacks.onDrop?.(), delay, interval);
  };
  const onDropPointerUp = (event: PointerEvent): void => {
    repeats.stop(`drop:${event.pointerId}`);
    releasePointer(options.dropButton, event.pointerId);
  };
  const onDropClick = (event: MouseEvent): void => {
    if (event.detail === 0) callbacks.onDrop?.();
  };
  options.dropButton.addEventListener("pointerdown", onDropPointerDown);
  options.dropButton.addEventListener("pointerup", onDropPointerUp);
  options.dropButton.addEventListener("pointercancel", onDropPointerUp);
  options.dropButton.addEventListener("lostpointercapture", onDropPointerUp);
  options.dropButton.addEventListener("click", onDropClick);
  cleanup.push(
    () =>
      options.dropButton.removeEventListener("pointerdown", onDropPointerDown),
    () => options.dropButton.removeEventListener("pointerup", onDropPointerUp),
    () =>
      options.dropButton.removeEventListener("pointercancel", onDropPointerUp),
    () =>
      options.dropButton.removeEventListener(
        "lostpointercapture",
        onDropPointerUp,
      ),
    () => options.dropButton.removeEventListener("click", onDropClick),
  );

  const onAimInput = (): void => emitAim(Number(options.aimInput?.value ?? 0));
  options.aimInput?.addEventListener("input", onAimInput);
  if (options.aimInput)
    cleanup.push(() =>
      options.aimInput?.removeEventListener("input", onAimInput),
    );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      emitAim(readAim() + (event.key === "ArrowLeft" ? -aimStep : aimStep));
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (!event.repeat)
        repeats.start(
          "keyboard:Space",
          () => callbacks.onDrop?.(),
          delay,
          interval,
        );
      return;
    }
    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      if (event.repeat) return;
      cancelRepeats();
      callbacks.onPause?.();
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      if (event.repeat) return;
      cancelRepeats();
      callbacks.onReset?.();
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === " ") repeats.stop("keyboard:Space");
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  cleanup.push(
    () => window.removeEventListener("keydown", onKeyDown),
    () => window.removeEventListener("keyup", onKeyUp),
  );

  function cancelRepeats(): void {
    repeats.stopAll();
    for (const pointerId of [...activePointers]) stopPointer(pointerId);
  }
  const onBlur = (): void => cancelRepeats();
  const onVisibility = (): void => {
    if (document.visibilityState !== "visible") cancelRepeats();
  };
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  cleanup.push(
    () => window.removeEventListener("blur", onBlur),
    () => document.removeEventListener("visibilitychange", onVisibility),
  );

  return {
    cancelRepeats,
    destroy: () => {
      cancelRepeats();
      for (const dispose of cleanup.splice(0)) dispose();
    },
  };
}

export { HoldRepeat };
