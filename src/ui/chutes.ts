import {
  DEFAULT_CHUTES,
  chuteSpacingLimits,
  sanitizeChutes,
  type ChuteSettings,
} from "../chutes";
import { MIN_COIN_DELAY_SECONDS } from "../simulation/config";

const FIELDS = [
  {
    key: "enemyChutes",
    id: "enemy-chutes",
    label: "Enemy chutes",
    min: 0,
    max: 4,
    step: 1,
  },
  {
    key: "chuteSpacing",
    id: "chute-spacing",
    label: "Chute spacing",
    min: 0,
    max: 3,
    step: 0.01,
  },
  {
    key: "dropDelay",
    id: "drop-delay",
    label: "Delay between coins (s)",
    min: MIN_COIN_DELAY_SECONDS,
    max: 0.5,
    step: 0.01,
  },
  {
    key: "dropsPerAction",
    id: "drops-per-action",
    label: "Coins per chute per click",
    min: 1,
    max: 30,
    step: 1,
  },
] as const;

export function createChuteControls(
  initialRadius: number,
  onChange?: (settings: ChuteSettings) => void,
) {
  let radius = initialRadius;
  let settings = sanitizeChutes({ ...DEFAULT_CHUTES }, { radius });
  const group = document.createElement("fieldset");
  group.className = "tuning-group";
  const legend = document.createElement("legend");
  legend.textContent = "Release chutes";
  const help = document.createElement("p");
  help.className = "chute-help";
  help.textContent =
    "One click releases one set: each chute releases the chosen number of coins, one at a time at the selected interval. Aim and release settings are captured per click. Pause or reset cancels queued coins. Spacing limits aim; odd enemy-chute counts add the extra chute on the left.";
  group.append(legend, help);
  const controls = FIELDS.map((field) => {
    const wrapper = document.createElement("div");
    wrapper.className = "tuning-field chute-field";
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = field.label;
    const output = document.createElement("span");
    output.id = `${field.id}-value`;
    output.className = "value-readout";
    const input = document.createElement("input");
    input.id = field.id;
    input.type = "range";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.setAttribute("aria-label", field.label);
    label.append(output);
    wrapper.append(label, input);
    group.append(wrapper);
    const onInput = () => {
      set({ ...settings, [field.key]: Number(input.value) }, radius);
      onChange?.({ ...settings });
    };
    input.addEventListener("input", onInput);
    return { field, output, input, onInput };
  });
  const total = document.createElement("p");
  total.className = "chute-total";
  group.append(total);

  function set(next: ChuteSettings, nextRadius: number): void {
    radius = nextRadius;
    settings = sanitizeChutes(next, { radius });
    const limits = chuteSpacingLimits(settings.enemyChutes, radius);
    for (const { field, input, output } of controls) {
      if (field.key === "chuteSpacing") {
        input.min = String(limits.min);
        input.max = String(limits.max);
        input.disabled = settings.enemyChutes === 0;
        input.title = input.disabled
          ? "Enable an enemy chute to change spacing."
          : "Distance between neighboring chutes.";
      }
      input.value = String(settings[field.key]);
      output.textContent = String(Math.round(settings[field.key] * 100) / 100);
    }
    total.textContent = `${settings.dropsPerAction} coins per chute; ${settings.dropsPerAction * (settings.enemyChutes + 1)} coins per click.`;
  }

  set(settings, radius);
  return {
    group,
    get: (): ChuteSettings => ({ ...settings }),
    set,
    destroy: () => {
      for (const { input, onInput } of controls)
        input.removeEventListener("input", onInput);
    },
  };
}
