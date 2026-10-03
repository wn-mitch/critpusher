import type { ChuteSlot } from "../chutes";

/** Physical studies may vary their opposing lane count independently of the run. */
export function createSyntheticSlots(enemyCount: number): ChuteSlot[] {
  if (!Number.isInteger(enemyCount) || enemyCount < 0 || enemyCount > 4) {
    throw new Error("Synthetic enemy count must be an integer from zero to four");
  }
  return [
    { id: "study-player", ownerId: "study-player", source: "player", slot: 0, enabled: true },
    ...Array.from({ length: enemyCount }, (_, index): ChuteSlot => ({
      id: `study-enemy-${index}`, ownerId: `study-enemy-${index}`, source: "enemy",
      slot: (index % 2 === 0 ? -1 : 1) * (Math.floor(index / 2) + 1), enabled: true,
    })),
  ];
}
