import type { CoinEvent, GizmoEvent } from "../contracts";
import { BOMB_DAMAGE, emptyTotals } from "./config";
import type { CombatEffect, CombatState, CombatStepResult, CombatTotals, EncounterConfig, EnemyHit } from "./types";
import type { ResolvedBuild } from "../run/modifiers";

export function resolveCombatStep(
  state: CombatState,
  events: readonly CoinEvent[],
  config: EncounterConfig,
  build?: ResolvedBuild,
  tick = 0,
  gizmoEvents: readonly GizmoEvent[] = [],
): CombatStepResult {
  const delta = emptyTotals();
  const effects: CombatEffect[] = [];
  if (state.result !== null) return { state, delta, effects };

  const enemies = state.enemies.map(enemy => ({ ...enemy }));
  const window = build?.combo.windowTicks ?? 0;
  const combo = { ...state.combo };
  if (!window || combo.lastSwordTick !== null && tick - combo.lastSwordTick >= window) {
    combo.chain = 0;
    combo.lastSwordTick = null;
  }
  let front = 0;
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    if (event.kind === "lost") continue;
    const effect: CombatEffect = {
      id: event.id,
      type: event.type,
      position: { ...event.position },
      enemyDamage: 0,
      swordMultiplier: 0,
      enemyHits: [],
      discardedDamage: 0,
      playerDamage: 0,
      healingOffered: 0,
      currency: 0,
      safeBomb: false,
      detonated: event.kind === "detonated",
      blastAssociated: event.kind === "detonated" && event.blastAssociated,
    };
    if (event.kind === "detonated") {
      const damage = build?.bombDamage ?? BOMB_DAMAGE;
      effect.enemyDamage = damage;
      effect.playerDamage = damage;
      delta.bombDamageToEnemy += damage;
      delta.bombDamageToPlayer += damage;
      delta.detonations += 1;
      if (event.blastAssociated) delta.blastAssociatedDetonations += 1;
    } else {
      switch (event.type) {
        case "gold":
          effect.currency = 1;
          break;
        case "diamond":
          effect.currency = 10;
          break;
        case "sword":
          if (window > 0) {
            combo.chain = Math.min(build!.combo.maxMultiplier, combo.chain + 1);
            combo.lastSwordTick = tick;
          }
          effect.swordMultiplier = window > 0 ? combo.chain : 1;
          effect.enemyDamage = (build?.swordDamage ?? config.swordDamage) * effect.swordMultiplier;
          delta.swordDamage += effect.enemyDamage;
          break;
        case "skull":
          effect.playerDamage = build?.skullDamage ?? config.skullDamage;
          delta.skullDamage += effect.playerDamage;
          break;
        case "potion":
          effect.healingOffered = build?.potionHealing ?? config.potionHealing;
          break;
        case "bomb":
          effect.safeBomb = true;
          delta.safeBombs += 1;
          break;
      }
    }
    let remainingDamage = effect.enemyDamage;
    if (remainingDamage > 0) {
      const hits: EnemyHit[] = [];
      while (remainingDamage > 0 && front < enemies.length) {
        const enemy = enemies[front]!;
        if (enemy.hp === 0) {
          front += 1;
          continue;
        }
        const damage = Math.min(enemy.hp, remainingDamage);
        enemy.hp -= damage;
        remainingDamage -= damage;
        delta.enemyHpRemoved += damage;
        hits.push({ enemyId: enemy.id, damage });
      }
      effect.enemyHits = hits;
      effect.discardedDamage = remainingDamage;
      delta.discardedDamage += remainingDamage;
    }
    delta.currencyGained += effect.currency;
    delta.healingOffered += effect.healingOffered;
    effects.push(effect);
  }
  for (const event of gizmoEvents)
    if (event.kind === "collected") delta.currencyGained += event.currency;

  const playerDamage = delta.skullDamage + delta.bombDamageToPlayer;
  const playerHp = Math.min(config.playerMaxHp, Math.max(0, state.playerHp - playerDamage + delta.healingOffered));
  const enemiesDefeated = enemies.every(enemy => enemy.hp === 0);
  // Healing belongs to the simultaneous batch, not any particular potion's order.
  delta.healingUsed = Math.min(delta.healingOffered, config.playerMaxHp - state.playerHp + playerDamage);
  delta.healingWasted = delta.healingOffered - delta.healingUsed;

  const totals = { ...state.totals };
  for (const key in delta) {
    const category = key as keyof CombatTotals;
    totals[category] += delta[category];
  }
  return {
    state: {
      playerHp,
      enemies,
      currency: state.currency + delta.currencyGained,
      result: playerHp === 0 && enemiesDefeated ? "simultaneous-defeat"
        : playerHp === 0 ? "defeat"
          : enemiesDefeated ? "victory" : null,
      totals,
      combo,
    },
    delta,
    effects,
  };
}
