import { COIN_TYPES, type CoinType, type SimulationStats } from "../contracts";
import { ENCOUNTERS } from "../run/catalog";
import type { RunSnapshot } from "../run/types";
import { stickerLabel } from "./run";
import type {
  CombatStepResult,
  EncounterPhase,
  EncounterSnapshot,
  FeedTray,
} from "../combat/types";
import { coinSymbolMarkup } from "../presentation/coin-symbols";
import { CHUTE_OWNERSHIP_COLORS } from "../presentation/chute-ownership";

export interface CombatUi {
  readonly group: HTMLElement;
  readonly legend: HTMLElement;
  readonly enemyRoster: HTMLElement;
  readonly playerHp: HTMLElement;
  readonly playerHpBar: HTMLElement;
  readonly enemyHp: HTMLElement;
  readonly enemyHpBar: HTMLElement;
  readonly currency: HTMLElement;
  readonly lifecycle: HTMLElement;
  readonly combatCues: HTMLElement;
  update(snapshot: EncounterSnapshot, trays: readonly FeedTray[]): void;
  updateRun(snapshot: RunSnapshot): void;
  showCombat(batch: CombatStepResult): void;
  updateDiagnostics(host: HTMLElement, stats: SimulationStats): void;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}


function displayNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function phaseLabel(phase: EncounterPhase, result: EncounterSnapshot["result"]): string {
  if (result === "victory") return "Victory";
  if (result === "simultaneous-defeat") return "Defeat: both combatants fell";
  if (result === "defeat") return "Defeat";
  switch (phase) {
    case "loading":
      return "Opening pile settling";
    case "active":
      return "Fight active";
    case "error":
      return "Fight unavailable";
    case "finished":
      return "Fight finished";
  }
}

function setBar(node: HTMLElement, value: number, maximum: number): void {
  const safeMaximum = Math.max(1, maximum);
  const safeValue = Math.min(safeMaximum, Math.max(0, value));
  node.setAttribute("aria-valuemin", "0");
  node.setAttribute("aria-valuemax", String(safeMaximum));
  node.setAttribute("aria-valuenow", String(safeValue));
  node.style.setProperty("--bar-fill", `${(safeValue / safeMaximum) * 100}%`);
}


function feedState(enabled: boolean, tray: FeedTray | undefined): string {
  if (!enabled) return "shuttered";
  if (!tray) return "magazine loading";
  let text = "";
  for (let index = 0; index < 5; index++) {
    if (index > 0) text += " · ";
    text += tray.coins[index]?.type ?? "—";
  }
  return text;
}

export function createCombatUi(
  host: HTMLElement,
  reducedMotion: () => boolean,
): CombatUi {
  let currentPhase: EncounterPhase = "loading";
  let lastInterruptedRounds = 0;
  let latestLoading: EncounterSnapshot["loading"] | undefined;
  const group = element("section", "combat-ui");
  group.setAttribute("aria-label", "Run combat");
  group.style.setProperty("--chute-player-color", CHUTE_OWNERSHIP_COLORS.player);
  group.style.setProperty("--chute-enemy-color", CHUTE_OWNERSHIP_COLORS.enemy);
  const heading = element("h2");
  heading.textContent = "Run combat";
  const stats = element("div", "combat-stats");
  const playerStat = element("div", "combat-stat player-stat");
  const enemyStat = element("div", "combat-stat enemy-stat");
  const currencyStat = element("div", "combat-stat currency-stat");
  const playerLabel = element("span", "combat-stat-label");
  playerLabel.textContent = "Player HP";
  const enemyLabel = element("span", "combat-stat-label");
  enemyLabel.textContent = "Enemy HP";
  const currencyLabel = element("span", "combat-stat-label");
  currencyLabel.textContent = "Currency";
  const playerHp = element("strong");
  const enemyHp = element("strong");
  const currency = element("strong");
  const playerHpBar = element("span", "hp-bar");
  const enemyHpBar = element("span", "hp-bar");
  for (const bar of [playerHpBar, enemyHpBar]) {
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
  }
  playerHpBar.setAttribute("aria-label", "Player health");
  enemyHpBar.setAttribute("aria-label", "Current wave health");
  playerStat.append(playerLabel, playerHp, playerHpBar);
  enemyStat.append(enemyLabel, enemyHp, enemyHpBar);
  currencyStat.append(currencyLabel, currency);
  stats.append(playerStat, enemyStat, currencyStat);

  const lifecycle = element("p", "combat-lifecycle");
  lifecycle.setAttribute("role", "status");
  lifecycle.setAttribute("aria-live", "polite");
  const combatCues = element("p", "combat-cues");
  combatCues.setAttribute("role", "status");
  combatCues.setAttribute("aria-live", "polite");
  const waveLabel = element("p", "combat-wave");
  const enemyRoster = element("ol", "enemy-roster");
  const enemyRows = Array.from({ length: 3 }, (_, index) => {
    const row = element("li", "enemy-row");
    row.dataset.row = String(index);
    const marker = element("span", "enemy-front-marker");
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "Front target";
    const label = element("span", "enemy-row-label");
    const hp = element("span", "enemy-row-hp");
    const pressure = element("span", "enemy-row-pressure");
    const feed = element("span", "enemy-row-feed chute-feed");
    feed.dataset.owner = "enemy";
    row.append(marker, label, hp, pressure, feed);
    enemyRoster.append(row);
    return { row, label, hp, pressure, feed };
  });
  const pressureRoster = element("ul", "pressure-roster");
  pressureRoster.setAttribute("aria-label", "Your magazine previews");
  const combo = element("p", "combo-readout");
  const stickers = element("ul", "run-stickers");
  stickers.setAttribute("aria-label", "Owned case stickers");

  const legend = element("div", "combat-legend");
  const legendTitle = element("h3");
  legendTitle.textContent = "Effects";
  legend.append(legendTitle);
  const legendList = element("ul");
  const legendDetails: Partial<Record<CoinType, HTMLElement>> = {};
  for (const type of COIN_TYPES) {
    const item = element("li");
    const icon = element("span");
    icon.innerHTML = coinSymbolMarkup(type);
    const copy = element("span");
    const name = element("strong");
    name.textContent = type;
    const detail = element("span");
    legendDetails[type] = detail;
    copy.append(name, " ", detail);
    item.append(icon, copy);
    legendList.append(item);
  }
  const updateLegend = (snapshot: RunSnapshot): void => {
    const config = snapshot.build;
    legendDetails.gold!.textContent = "+1 currency";
    legendDetails.diamond!.textContent = "+10 currency";
    legendDetails.sword!.textContent = `−${displayNumber(config.swordDamage)} enemy`;
    legendDetails.skull!.textContent = `−${displayNumber(config.skullDamage)} player`;
    legendDetails.potion!.textContent = `+${displayNumber(config.potionHealing)} HP`;
    legendDetails.bomb!.textContent = `${config.bombDamage} HP damage to each side on detonation`;
  };
  legend.append(legendList);


  group.append(heading, stats, lifecycle, waveLabel, enemyRoster, pressureRoster, combatCues, combo, stickers);
  host.append(group);


  const update = (snapshot: EncounterSnapshot, trays: readonly FeedTray[]): void => {
    latestLoading = snapshot.loading;
    if (snapshot.phase === "loading" && currentPhase !== "loading") {
      lastInterruptedRounds = 0;
      combatCues.textContent = "";
      combatCues.classList.remove("is-animated");
    }
    currentPhase = snapshot.phase;
    const enemyHpTotal = snapshot.enemies.reduce((sum, enemy) => sum + enemy.hp, 0);
    const enemyMaxHpTotal = snapshot.enemies.reduce((sum, enemy) => sum + enemy.maxHp, 0);
    playerHp.textContent = `${displayNumber(snapshot.playerHp)} / ${displayNumber(snapshot.playerMaxHp)}`;
    enemyHp.textContent = `${displayNumber(enemyHpTotal)} / ${displayNumber(enemyMaxHpTotal)}`;
    currency.textContent = String(snapshot.currency);
    setBar(playerHpBar, snapshot.playerHp, snapshot.playerMaxHp);
    setBar(enemyHpBar, enemyHpTotal, enemyMaxHpTotal);
    waveLabel.textContent = `Wave ${snapshot.waveIndex + 1} / ${snapshot.waveCount}`;
    enemyRows.forEach(({ row, label, hp, pressure, feed }, index) => {
      const enemy = snapshot.enemies[index];
      const isFront = enemy?.id === snapshot.frontEnemyId;
      const slot = enemy ? snapshot.chuteSlots.find((slot) => slot.id === enemy.chuteId) : undefined;
      const state = enemy ? feedState(slot?.enabled ?? enemy.hp > 0, trays.find((tray) => tray.id === enemy.chuteId)) : "";
      row.classList.toggle("is-front", isFront);
      row.dataset.empty = String(enemy === undefined);
      row.dataset.enabled = String(slot?.enabled ?? (enemy?.hp ?? 0) > 0);
      row.setAttribute("aria-label", enemy
        ? `${isFront ? "Front target, " : ""}${enemy.name}, ${displayNumber(enemy.hp)} of ${displayNumber(enemy.maxHp)} HP, ${enemy.admittedRounds} rounds admitted, enemy chute ${index + 1}: ${state}`
        : "No enemy");
      label.textContent = enemy ? `${index + 1}. ${enemy.name}` : "Awaiting enemy";
      hp.textContent = enemy
        ? `${displayNumber(enemy.hp)} / ${displayNumber(enemy.maxHp)}`
        : "—";
      pressure.textContent = !enemy ? "" : enemy.kind === "escalator"
        ? enemy.admittedRounds < 10
          ? `${enemy.admittedRounds}/${enemy.admittedRounds < 5 ? 5 : 10} rounds → +1 skull`
          : `Maximum skull pressure · ${enemy.admittedRounds} rounds`
        : `${enemy.admittedRounds} rounds`;
      feed.textContent = enemy ? `Enemy chute ${index + 1}: ${state}` : "";
    });
    pressureRoster.replaceChildren();
    for (const slot of snapshot.chuteSlots) {
      if (slot.source !== "player") continue;
      const item = element("li", "chute-feed");
      item.dataset.owner = "player";
      const owner = `Your chute ${snapshot.playerChutes.findIndex((chute) => chute.id === slot.id) + 1}`;
      const state = feedState(slot.enabled, trays.find((tray) => tray.id === slot.id));
      item.textContent = `${owner}: ${state}`;
      item.dataset.enabled = String(slot.enabled);
      pressureRoster.append(item);
    }
    lifecycle.textContent = phaseLabel(snapshot.phase, snapshot.result);
    lifecycle.dataset.phase = snapshot.phase;
    group.dataset.phase = snapshot.phase;
    if (snapshot.interruptedRounds > lastInterruptedRounds) {
      combatCues.textContent = `Release interrupted: ${snapshot.interruptedRounds - lastInterruptedRounds} unadmitted rounds canceled.`;
    }
    lastInterruptedRounds = snapshot.interruptedRounds;
  };

  const updateRun = (snapshot: RunSnapshot): void => {
    waveLabel.textContent = snapshot.phase === "starter" ? "Three encounters · Two waves each"
      : `Encounter ${snapshot.encounterIndex + 1}/${snapshot.encounterCount} · ${ENCOUNTERS[snapshot.encounterIndex]!.name} · Wave ${snapshot.encounter.waveIndex + 1}/${snapshot.encounter.waveCount}`;
    playerHp.textContent = `${snapshot.playerHp} / ${snapshot.maxHp}`;
    currency.textContent = String(snapshot.currency);
    setBar(playerHpBar, snapshot.playerHp, snapshot.maxHp);
    if (snapshot.phase === "starter") {
      lifecycle.textContent = "Choose a kit";
      enemyHp.textContent = "Not started";
      setBar(enemyHpBar, 0, 1);
      enemyRows.forEach(({ row, label, hp, pressure, feed }) => {
        row.classList.remove("is-front");
        row.dataset.empty = "true";
        row.setAttribute("aria-label", "Choose a kit to begin");
        label.textContent = "Awaiting your kit";
        hp.textContent = "";
        pressure.textContent = "";
        feed.textContent = "";
      });
      pressureRoster.replaceChildren();
    }
    const { chain, lastSwordTick } = snapshot.encounter.combo;
    const remaining = lastSwordTick === null ? 0 : Math.max(0, snapshot.build.combo.windowTicks - (snapshot.encounter.tick - lastSwordTick));
    combo.textContent = snapshot.stickers.includes("combo-bell")
      ? remaining > 0 ? `Combo ×${Math.min(chain, snapshot.build.combo.maxMultiplier)} · ${(remaining / 60).toFixed(1)}s left · next sword ×${Math.min(chain + 1, snapshot.build.combo.maxMultiplier)}`
        : "Combo ready: next sword ×1. Bell pays 3 on collection; returns next encounter."
      : "";
    stickers.replaceChildren(...snapshot.stickers.map((id) => {
      const item = element("li");
      item.textContent = stickerLabel(id);
      return item;
    }));
    updateLegend(snapshot);
  };

  const showCombat = (batch: CombatStepResult): void => {
    const delta = batch.delta;
    const cues: string[] = [];
    const outgoing = delta.swordDamage + delta.bombDamageToEnemy;
    const incoming = delta.skullDamage + delta.bombDamageToPlayer;
    if (outgoing > 0) cues.push(`Attack −${displayNumber(outgoing)} enemy`);
    if (incoming > 0) cues.push(`Incoming −${displayNumber(incoming)} player`);
    if (delta.healingUsed > 0) cues.push(`Healing +${displayNumber(delta.healingUsed)} used`);
    if (delta.currencyGained > 0) cues.push(`Currency +${displayNumber(delta.currencyGained)}`);
    if (delta.detonations > 0) cues.push(`${delta.detonations} bomb detonation${delta.detonations === 1 ? "" : "s"}`);
    combatCues.textContent = cues.slice(0, 5).join(" · ");
    combatCues.classList.toggle("is-animated", !reducedMotion() && cues.length > 0);
  };

  const updateDiagnostics = (metricsHost: HTMLElement, stats: SimulationStats): void => {
    const diagnostics = element("div", "combat-diagnostics");
    const rows: Array<[string, string]> = [
      ["Caught", String(stats.collected)],
      ["Active", String(stats.active)],
      ["Lost", String(stats.lost)],
      ["Detonated", String(stats.detonated)],
    ];
    for (const type of COIN_TYPES) {
      rows.push([`Caught ${type}`, String(stats.collectedByType[type])]);
      if (latestLoading) {
        rows.push([`Loading lost ${type}`, displayNumber(latestLoading.lostByType[type])]);
      }
    }
    const list = element("dl");
    for (const [label, value] of rows) {
      const name = element("dt");
      name.textContent = label;
      const reading = element("dd");
      reading.textContent = value;
      list.append(name, reading);
    }
    diagnostics.append(list);
    metricsHost.append(diagnostics);
  };

  return {
    group,
    legend,
    enemyRoster,
    playerHp,
    playerHpBar,
    enemyHp,
    enemyHpBar,
    currency,
    lifecycle,
    combatCues,
    update,
    updateRun,
    showCombat,
    updateDiagnostics,
    destroy() {
      group.remove();
      legend.remove();
    },
  };
}
