import {
  DEFAULT_CHUTES,
  sanitizeChutes,
  type ChuteSettings,
} from "../chutes";
import { MIN_COIN_DELAY_SECONDS } from "../simulation/config";

const FIELDS = [
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
    "Aim, spacing, rounds, and minimum delay are captured per click. Native magazines wait until their outlets clear. Pause or reset cancels unadmitted rounds. The run determines chute ownership.";
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
    const limits = { min: 2 * radius + 0.02, max: 3 };
    for (const { field, input, output } of controls) {
      if (field.key === "chuteSpacing") {
        input.min = String(limits.min);
        input.max = String(limits.max);
        input.title = "Distance between reserved chute slots.";
      }
      input.value = String(settings[field.key]);
      output.textContent = String(Math.round(settings[field.key] * 100) / 100);
    }
    total.textContent = `${settings.dropsPerAction} rounds per click; enemy feeds release with player feeds.`;
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
