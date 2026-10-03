import { DEFAULT_ENCOUNTER_CONFIG } from "../combat/config";
import type { CoinType } from "../contracts";
import type { EncounterConfig, EnemyDefinition, WaveDefinition } from "../combat/types";
import type { ShopOffer, StarterDefinition } from "./types";

export const VICTORY_REWARD = 12;
export const INTER_ENCOUNTER_HEAL = 12;
export const MAX_PLAYER_CHUTES = 3;
export const MAX_STICKERS = 3;
export const MAX_EFFECT_LEVEL = 2;

export const STARTERS: readonly StarterDefinition[] = [
  {
    id: "collector", label: "Collector", bag: ["sword", "sword", "sword", "potion", "gold"],
    sticker: "collected-only", description: "Only collected coins change HP; bomb blasts still move the pile.",
    tradeoff: "Avoid blast damage, but give up bomb offense.",
  },
  {
    id: "swarm", label: "Pocket army", bag: ["sword", "sword", "sword", "sword", "potion"],
    sticker: "miniature", description: "Coins are 25% smaller and the opening pile has 50% more coins.",
    tradeoff: "More packing and volume, but swords deal 2 base damage and the extra pile includes hazards.",
  },
  {
    id: "volley", label: "Volley", bag: ["sword", "sword", "sword", "sword", "bomb"],
    sticker: "magazine-dump", description: "Each release opens all five staged rows under gravity.",
    tradeoff: "A full burst also releases the enemies' five rows; no potion in the starting bag.",
  },
];

export const SHOP_OFFERS: readonly ShopOffer[] = [
  { id: "sword-pack", label: "Sword pack", price: 8, description: "Replace one bomb, gold, diamond, or potion with a sword." },
  { id: "potion-pack", label: "Potion pack", price: 8, description: "Replace one sword, bomb, gold, or diamond with a potion." },
  { id: "gold-pack", label: "Gold pack", price: 8, description: "Replace one sword, bomb, potion, or diamond with gold." },
  { id: "diamond-mint", label: "Diamond mint", price: 16, description: "Replace one gold with a diamond." },
  { id: "tempered-swords", label: "Tempered swords", price: 16, description: "+1 base damage per collected sword. Maximum two levels." },
  { id: "restorative-brew", label: "Restorative brew", price: 16, description: "+2 healing per collected potion. Maximum two levels." },
  { id: "extra-chute", label: "Extra player chute", price: 28, description: "Clone the selected chute's current bag. Maximum three chutes." },
  { id: "collected-only", label: "Collected-only sticker", price: 20, description: "Bomb blasts retain their physics but deal no HP damage." },
  { id: "miniature", label: "Miniature sticker", price: 18, description: "25% smaller coins, 50% more opening coins, and base sword damage 2." },
  { id: "magazine-dump", label: "Magazine-dump sticker", price: 22, description: "Release all five staged rows from every participating chute." },
  { id: "combo-bell", label: "Combo bell sticker", price: 20, description: "Swords within 2.4 seconds chain ×1/×2/×3. A physical bell pays 3 when collected." },
];

export interface RunEncounterDefinition { id: string; name: string; config: EncounterConfig }
const ENEMY_BAGS: Record<EnemyDefinition["kind"], readonly CoinType[]> = {
  trainee: ["skull", "skull", "skull", "gold", "gold"],
  escort: ["skull", "skull", "skull", "gold", "gold"],
  guard: ["skull", "skull", "skull", "skull", "gold"],
  escalator: ["skull", "skull", "skull", "gold", "gold"],
  foreman: ["skull", "skull", "skull", "bomb", "gold"],
};
function wave(encounter: number, index: number, roster: readonly [EnemyDefinition["kind"], number][]): WaveDefinition {
  const prefix = `encounter-${encounter}-wave-${index}`;
  return { id: prefix, enemies: roster.map(([kind, maxHp], ordinal) => ({
    id: `${prefix}-enemy-${ordinal}`, chuteId: `${prefix}-chute-${ordinal}`,
    name: `${kind[0]!.toUpperCase()}${kind.slice(1)} ${ordinal + 1}`, kind, maxHp, bag: [...ENEMY_BAGS[kind]],
  })) };
}
export const ENCOUNTERS: readonly RunEncounterDefinition[] = [
  {
    id: "encounter-1", name: "Training floor",
    config: { ...DEFAULT_ENCOUNTER_CONFIG,
      openingMix: { gold: 25, diamond: 1, sword: 35, skull: 28, potion: 10, bomb: 1 },
      waves: [wave(1, 1, [["trainee", 20], ["trainee", 20]]), wave(1, 2, [["guard", 30]])],
    },
  },
  {
    id: "encounter-2", name: "Overclock floor",
    config: { ...DEFAULT_ENCOUNTER_CONFIG,
      openingMix: { gold: 23, diamond: 1, sword: 32, skull: 27, potion: 16, bomb: 1 },
      waves: [wave(2, 1, [["guard", 35], ["escalator", 40]]), wave(2, 2, [["escalator", 50], ["guard", 35]])],
    },
  },
  {
    id: "encounter-3", name: "Foreman floor",
    config: { ...DEFAULT_ENCOUNTER_CONFIG,
      openingMix: { gold: 22, diamond: 1, sword: 30, skull: 32, potion: 14, bomb: 1 },
      waves: [wave(3, 1, [["guard", 35], ["escalator", 50], ["guard", 35]]),
        wave(3, 2, [["foreman", 65], ["escort", 25], ["escort", 25]])],
    },
  },
];
