import { COIN_TYPES, type CoinType, type Tuning } from "../contracts";
import { MAX_EFFECT_LEVEL, MAX_PLAYER_CHUTES, MAX_STICKERS, SHOP_OFFERS } from "./catalog";
import { resolveBuild } from "./modifiers";
import type { BagCounts, BaseEffects, CompositionOfferId, PurchaseFailure, PurchasePreview, PurchaseRequest, RunInventory, RunPhase } from "./types";

const COMPOSITION: Record<CompositionOfferId, { target: CoinType; sources: readonly CoinType[] }> = {
  "sword-pack": { target: "sword", sources: ["bomb", "gold", "diamond", "potion"] },
  "potion-pack": { target: "potion", sources: ["sword", "bomb", "gold", "diamond"] },
  "gold-pack": { target: "gold", sources: ["sword", "bomb", "potion", "diamond"] },
  "diamond-mint": { target: "diamond", sources: ["gold"] },
};

export function bagCounts(bag: readonly CoinType[]): BagCounts {
  const counts: BagCounts = { gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 };
  for (const type of bag) counts[type]++;
  return counts;
}

/** Calculate on a private candidate; a rejected purchase never changes ownership or money. */
export function calculatePurchase(
  phase: RunPhase, inventory: RunInventory, currency: number, request: PurchaseRequest,
  tuning: Tuning, effects: BaseEffects,
): { preview: PurchasePreview; inventory: RunInventory } {
  const offer = SHOP_OFFERS.find(({ id }) => id === request?.offerId);
  const candidate = structuredClone(inventory);
  const currentBuild = resolveBuild(inventory, tuning, effects);
  let blocker: PurchaseFailure | null = null;
  if (phase !== "shop") blocker = "not-in-shop";
  else if (!offer) blocker = "unknown-offer";
  else {
    const id = offer.id;
    if (id === "sword-pack" || id === "potion-pack" || id === "gold-pack" || id === "diamond-mint") {
      const composition = COMPOSITION[id];
      const chute = "chuteId" in request ? candidate.playerChutes.find(({ id }) => id === request.chuteId) : undefined;
      if (!chute) blocker = "unknown-chute";
      else if (!("replaceType" in request) || !COIN_TYPES.includes(request.replaceType)
        || !composition.sources.includes(request.replaceType) || !chute.bag.includes(request.replaceType)) blocker = "invalid-replacement";
      else {
        const bag = [...chute.bag];
        bag[bag.indexOf(request.replaceType)] = composition.target;
        candidate.playerChutes = candidate.playerChutes.map((entry) => entry.id === chute.id ? { ...entry, bag } : entry);
      }
    } else if (id === "extra-chute") {
      const chute = "chuteId" in request ? candidate.playerChutes.find(({ id }) => id === request.chuteId) : undefined;
      if (!chute) blocker = "unknown-chute";
      else if (candidate.playerChutes.length >= MAX_PLAYER_CHUTES) blocker = "limit-reached";
      else candidate.playerChutes = [...candidate.playerChutes, { id: `player-${candidate.playerChutes.length}`, bag: [...chute.bag] }];
    } else if (id === "tempered-swords" || id === "restorative-brew") {
      const level = id === "tempered-swords" ? "temperedSwords" : "restorativeBrew";
      if (candidate.effectLevels[level] >= MAX_EFFECT_LEVEL) blocker = "limit-reached";
      else candidate.effectLevels[level]++;
    } else {
      if (candidate.stickers.includes(id)) blocker = "already-owned";
      else if (candidate.stickers.length >= MAX_STICKERS) blocker = "limit-reached";
      else candidate.stickers = [...candidate.stickers, id];
    }
  }
  // An unaffordable but otherwise valid offer still shows exactly what it would buy.
  const resulting = blocker ? inventory : candidate;
  const cost = offer?.price ?? 0;
  if (!blocker && currency < cost) blocker = "insufficient-currency";
  return {
    inventory: blocker ? inventory : candidate,
    preview: {
      request: structuredClone(request), allowed: blocker === null, blocker, cost,
      remainingMoney: currency - cost,
      currentCounts: inventory.playerChutes.map(({ id, bag }) => ({ chuteId: id, counts: bagCounts(bag) })),
      resultingCounts: resulting.playerChutes.map(({ id, bag }) => ({ chuteId: id, counts: bagCounts(bag) })),
      currentBuild, resultingBuild: resolveBuild(resulting, tuning, effects),
      resultingChuteCount: resulting.playerChutes.length, resultingStickerCount: resulting.stickers.length,
    },
  };
}
