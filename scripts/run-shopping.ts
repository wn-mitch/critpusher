import { COIN_TYPES, type CoinType } from "../src/contracts";
import { SHOP_OFFERS } from "../src/run/catalog";
import type { CompositionOfferId, OfferId, PurchaseRequest, Run, RunSnapshot } from "../src/run/types";
import type { BuildProfile, ShopTrace } from "./run-contracts";
import { canonicalJson, REPLACEMENT_ORDER, SHOP_PURCHASE_LIMIT } from "./run-protocol";

const TARGETS: Record<CompositionOfferId, CoinType> = { "sword-pack": "sword", "potion-pack": "potion", "gold-pack": "gold", "diamond-mint": "diamond" };
export function requestsFor(offerId: OfferId, snapshot: RunSnapshot): PurchaseRequest[] {
  const chute = snapshot.playerChutes[0];
  if (!chute) throw new Error("Shop has no owned player chute");
  if (offerId === "extra-chute") return [{ offerId, chuteId: chute.id }];
  if (Object.hasOwn(TARGETS, offerId)) {
    const composition = offerId as CompositionOfferId;
    return REPLACEMENT_ORDER.filter((type) => chute.bag.includes(type) && type !== TARGETS[composition] &&
      (composition !== "diamond-mint" || type === "gold"))
      .map((replaceType) => ({ offerId: composition, chuteId: chute.id, replaceType }));
  }
  return [{ offerId: offerId as Exclude<OfferId, CompositionOfferId | "extra-chute"> }];
}
export function purchaseCounts(snapshot: RunSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const purchase of snapshot.purchases) counts[purchase.request.offerId] = (counts[purchase.request.offerId] ?? 0) + 1;
  return counts;
}
function assertPurchase(run: Run, before: RunSnapshot, request: PurchaseRequest, cost: number): void {
  const after = run.snapshot();
  if (after.currency !== before.currency - cost || after.spentCurrency !== before.spentCurrency + cost ||
    after.earnedCurrency !== before.earnedCurrency || after.purchases.length !== before.purchases.length + 1 ||
    canonicalJson(after.purchases.at(-1)?.request) !== canonicalJson(request)) throw new Error("Purchase charge/ownership accounting diverged");
  if (after.playerChutes.some((chute) => chute.bag.length !== 5 || chute.bag.some((type) => !COIN_TYPES.includes(type))))
    throw new Error("Purchased bag is not a valid five-token replenishing feed");
}
export function runShop(run: Run, profile: BuildProfile, replay?: ShopTrace): ShopTrace {
  const before = run.snapshot();
  if (before.phase !== "shop") throw new Error("Shopping attempted outside shop");
  const opportunities = SHOP_OFFERS.flatMap((offer) => requestsFor(offer.id, before).map((request) => run.previewPurchase(request)));
  const trace: ShopTrace = { encounterIndex: before.encounterIndex, before, after: before, opportunities, attempts: [] };
  if (replay && (replay.encounterIndex !== before.encounterIndex || replay.attempts.length > SHOP_PURCHASE_LIMIT)) throw new Error("Invalid recorded shop decisions");
  for (let index = 0; index < SHOP_PURCHASE_LIMIT; index++) {
    const snapshot = run.snapshot();
    let request: PurchaseRequest | undefined;
    if (replay) request = replay.attempts[index]?.request;
    else {
      const counts = purchaseCounts(snapshot);
      for (const priority of profile.priorities) {
        if ((counts[priority.offerId] ?? 0) >= priority.cap) continue;
        request = requestsFor(priority.offerId, snapshot).find((candidate) => run.previewPurchase(candidate).allowed);
        if (request) break;
      }
    }
    if (!request) break;
    const preview = run.previewPurchase(request);
    if (!preview.allowed) throw new Error(`Recorded/scripted purchase is not legal: ${preview.blocker}`);
    const result = run.purchase(request);
    trace.attempts.push({ request: structuredClone(request), preview, result });
    if (!result.success || canonicalJson(result.preview) !== canonicalJson(preview)) throw new Error("Shop preview and atomic purchase diverged");
    assertPurchase(run, snapshot, request, preview.cost);
  }
  trace.after = run.snapshot();
  return trace;
}
