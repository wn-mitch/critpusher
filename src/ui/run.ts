import { COIN_TYPES, type CoinType } from "../contracts";
import { ENCOUNTERS, MAX_PLAYER_CHUTES, MAX_STICKERS, SHOP_OFFERS, STARTERS } from "../run/catalog";
import type { ResolvedBuild } from "../run/modifiers";
import type { BagCounts, OfferId, PurchaseFailure, PurchasePreview, PurchaseRequest, PurchaseResult, RunSnapshot, StarterId, StickerId } from "../run/types";
import { coinSymbolMarkup } from "../presentation/coin-symbols";
import { offerIcon } from "./offer-icons";

const BLOCKERS: Record<PurchaseFailure, string> = {
  "not-in-shop": "Purchases are available between encounters.",
  "unknown-offer": "This offer is unavailable.",
  "unknown-chute": "Select an owned chute.",
  "invalid-replacement": "That coin cannot be replaced by this offer. Choose a source coin explicitly.",
  "insufficient-currency": "Not enough currency.",
  "limit-reached": "This upgrade has reached its limit.",
  "already-owned": "This unique sticker is already owned.",
};
export function stickerLabel(id: StickerId): string {
  return SHOP_OFFERS.find((offer) => offer.id === id)!.label;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = text;
  result.className = className;
  return result;
}
function action(label: string, callback: () => void, primary = false): HTMLButtonElement {
  const result = node("button", label, primary ? "run-primary" : "");
  result.type = "button";
  result.addEventListener("click", callback);
  return result;
}
function countsText(counts: Partial<BagCounts>): string {
  return COIN_TYPES.filter((type) => counts[type]).map((type) => `${counts[type]} ${type}`).join(" · ");
}
function bagText(bag: readonly CoinType[]): string {
  return countsText(Object.fromEntries(COIN_TYPES.map((type) => [type, bag.filter((coin) => coin === type).length])));
}
function properties(build: ResolvedBuild): Record<string, string> {
  return {
    "Sword damage": String(build.swordDamage),
    "Potion healing": String(build.potionHealing),
    "Blast HP damage per side": String(build.bombDamage),
    "Coin radius": build.tuning.radius.toFixed(2),
    "Coin thickness": build.tuning.thickness.toFixed(3),
    "Opening coins": String(build.tuning.density),
    "Release": build.releaseMode === "dump" ? "Five-row burst" : "Single row",
    "Combo": build.combo.windowTicks ? "×1/×2/×3 within 2.4s" : "None",
  };
}
function bagCounts(counts: Partial<BagCounts>, label: string): HTMLElement {
  const bag = node("div", "", "bag-preview");
  bag.append(node("span", label, "bag-preview-label"));
  for (const type of COIN_TYPES.filter((coin) => counts[coin])) {
    const token = node("span", "", "bag-token");
    const icon = node("span", "", "bag-token-icon");
    icon.innerHTML = coinSymbolMarkup(type);
    token.append(icon, node("span", `${counts[type]} ${type}`));
    bag.append(token);
  }
  return bag;
}
interface RunUiCallbacks {
  chooseStarter(id: StarterId): boolean;
  previewPurchase(request: PurchaseRequest): PurchasePreview;
  purchase(request: PurchaseRequest): PurchaseResult;
  continueRun(): boolean;
  restart(): void;
}
export function createRunUi(host: HTMLElement, callbacks: RunUiCallbacks) {
  const heading = node("h2", "Choose your kit");
  heading.tabIndex = -1;
  heading.id = "run-heading";
  host.setAttribute("aria-labelledby", heading.id);
  const content = node("div", "", "run-content");
  const navigation = node("div", "", "shop-navigation");
  const notice = node("p", "", "run-notice");
  notice.setAttribute("role", "status");
  host.className = "run-panel";
  host.append(heading, notice, content, navigation);
  let current: RunSnapshot | undefined;
  let renderedKey = "";
  let selectedOffer: OfferId = "sword-pack";
  let selectedChute = "";
  let replaceType: CoinType = "sword";

  function request(offerId = selectedOffer): PurchaseRequest {
    if (offerId === "sword-pack" || offerId === "potion-pack" || offerId === "gold-pack" || offerId === "diamond-mint") {
      return { offerId, chuteId: selectedChute, replaceType };
    }
    return offerId === "extra-chute" ? { offerId, chuteId: selectedChute } : { offerId };
  }
  function starters(): void {
    const choices = node("div", "", "starter-choices");
    for (const starter of STARTERS) {
      const choice = node("section", "", "starter-choice");
      choice.dataset.starter = starter.id;
      const choiceHeading = node("h3", starter.label);
      choiceHeading.id = `starter-${starter.id}-heading`;
      choice.setAttribute("aria-labelledby", choiceHeading.id);
      choice.append(choiceHeading, node("p", `Five-token bag: ${bagText(starter.bag)}`, "bag-counts"),
        node("p", `Sticker: ${stickerLabel(starter.sticker)}`, "sticker-label"), node("p", starter.description),
        node("p", `Tradeoff: ${starter.tradeoff}`, "tradeoff"));
      const choose = action("Choose kit", () => {
        if (!callbacks.chooseStarter(starter.id)) notice.textContent = "The kit could not start. Check the machine status.";
      }, true);
      choose.dataset.starter = starter.id;
      choose.setAttribute("aria-label", `Choose ${starter.label} kit`);
      choice.append(choose);
      choices.append(choice);
    }
    content.append(node("p", "One chute and one sticker to start. Every five-coin bag replenishes for the whole run."), choices);
  }
  function buildSummary(snapshot: RunSnapshot): HTMLElement {
    const build = node("div", "", "run-build");
    const bags = node("ul", "", "run-bags");
    snapshot.playerChutes.forEach((chute, index) => bags.append(node("li", `Chute ${index + 1}: ${bagText(chute.bag)}`)));
    build.append(bags, node("p", `Case stickers ${snapshot.stickers.length}/${MAX_STICKERS}: ${snapshot.stickers.map(stickerLabel).join(" · ") || "None"}`),
      node("p", `Tempered swords ${snapshot.effectLevels.temperedSwords} · Restorative brew ${snapshot.effectLevels.restorativeBrew}`));
    return build;
  }
  function shop(snapshot: RunSnapshot): void {
    const service = snapshot.completionServices.at(-1);
    content.append(node("p", `${ENCOUNTERS[snapshot.encounterIndex]!.name} cleared · Payout +${service?.reward ?? 0} · Recovery +${service?.recovery?.used ?? 0} HP (${service?.recovery?.wasted ?? 0} unused)`, "shop-reward"),
      node("p", `Carried HP ${snapshot.playerHp}/${snapshot.maxHp} · Currency ${snapshot.currency}`, "shop-balance"));
    const owned = node("details", "", "shop-owned");
    owned.append(node("summary", `Your build · ${snapshot.playerChutes.length}/${MAX_PLAYER_CHUTES} chutes · ${snapshot.stickers.length}/${MAX_STICKERS} stickers`), buildSummary(snapshot));
    content.append(owned);
    if (!snapshot.playerChutes.some((chute) => chute.id === selectedChute)) selectedChute = snapshot.playerChutes[0]!.id;
    const form = node("div", "", "shop-selection");
    const chuteLabel = node("label", "Target / clone source chute");
    const chuteSelect = node("select");
    chuteSelect.id = "shop-chute";
    chuteSelect.name = "shop-chute";
    chuteSelect.setAttribute("aria-label", "Target or clone source chute");
    snapshot.playerChutes.forEach((chute, index) => {
      const option = node("option", `Chute ${index + 1}: ${bagText(chute.bag)}`);
      option.value = chute.id;
      chuteSelect.append(option);
    });
    chuteSelect.value = selectedChute;
    chuteLabel.append(chuteSelect);
    const sourceLabel = node("label", "Coin to replace (one token)");
    const source = node("select");
    source.id = "shop-source";
    source.name = "shop-source";
    source.setAttribute("aria-label", "Coin to replace");
    for (const type of COIN_TYPES) {
      const option = node("option", type);
      option.value = type;
      source.append(option);
    }
    source.value = replaceType;
    sourceLabel.append(source);
    form.append(chuteLabel, sourceLabel);
    const offers = node("div", "", "shop-offers");
    const previewHost = node("section", "", "purchase-preview");
    previewHost.setAttribute("aria-label", "Purchase preview");
    previewHost.setAttribute("aria-live", "polite");
    previewHost.setAttribute("aria-atomic", "true");
    const review = action("", () => {
      content.scrollTop = previewHost.offsetTop;
      previewHost.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    });
    const offerButtons: { id: OfferId; button: HTMLButtonElement; reason: HTMLElement }[] = [];
    for (const offer of SHOP_OFFERS) {
      const row = node("div", "", "shop-offer");
      const select = action("", () => { selectedOffer = offer.id; refresh(); });
      const label = node("span", offer.label, "shop-offer-label");
      label.append(node("span", `${offer.price} currency`, "shop-offer-price"));
      select.append(offerIcon(offer.id), label);
      select.dataset.offer = offer.id;
      select.setAttribute("aria-label", `${offer.label}, ${offer.price} currency`);
      const reason = node("p");
      reason.id = `offer-${offer.id}-reason`;
      select.setAttribute("aria-describedby", reason.id);
      row.append(select, reason);
      offers.append(row);
      offerButtons.push({ id: offer.id, button: select, reason });
    }
    function refresh(): void {
      for (const { id, button, reason } of offerButtons) {
        const preview = callbacks.previewPurchase(request(id));
        button.setAttribute("aria-pressed", String(id === selectedOffer));
        reason.textContent = preview.blocker ? BLOCKERS[preview.blocker] : "Available";
      }
      const purchaseRequest = request();
      const preview = callbacks.previewPurchase(purchaseRequest);
      const offer = SHOP_OFFERS.find((item) => item.id === selectedOffer)!;
      review.textContent = `Review ${offer.label}`;
      source.disabled = !("replaceType" in purchaseRequest);
      chuteSelect.disabled = !("chuteId" in purchaseRequest);
      const previewHeading = node("h3", "", "purchase-heading");
      previewHeading.tabIndex = -1;
      previewHeading.append(offerIcon(offer.id), node("span", offer.label));
      previewHost.replaceChildren(previewHeading, node("p", offer.description));
      preview.currentCounts.forEach((before, index) => {
        const after = preview.resultingCounts.find((item) => item.chuteId === before.chuteId);
        const changed = countsText(before.counts) !== countsText(after?.counts ?? before.counts);
        if (before.chuteId === selectedChute || changed) {
          const feeds = node("div", "", "feed-comparison");
          feeds.append(bagCounts(before.counts, `Chute ${index + 1} · Now`),
            bagCounts(after?.counts ?? before.counts, changed ? "After purchase" : "Unchanged"));
          previewHost.append(feeds);
        }
      });
      for (const after of preview.resultingCounts.filter((item) => !preview.currentCounts.some((before) => before.chuteId === item.chuteId))) {
        previewHost.append(bagCounts(after.counts, "New independent chute"),
          node("p", `Next player slot: ${preview.resultingChuteCount === 2 ? "right (+1)" : "left (−1)"}. All chutes share your aim.`));
      }
      const beforeProperties = properties(preview.currentBuild);
      const afterProperties = properties(preview.resultingBuild);
      const changes = Object.keys(beforeProperties).filter((name) => beforeProperties[name] !== afterProperties[name]);
      previewHost.append(node("p", changes.length
        ? changes.map((name) => `${name}: ${beforeProperties[name]} → ${afterProperties[name]}`).join(" · ")
        : "Coin properties and release behavior unchanged.", "effect-comparison"));
      const allProperties = node("details", "", "shop-properties");
      allProperties.append(node("summary", "All resulting coin & release properties"),
        node("p", Object.entries(afterProperties).map(([name, value]) => `${name}: ${value}`).join(" · ")));
      previewHost.append(allProperties,
        node("p", `Chutes ${preview.currentCounts.length} → ${preview.resultingChuteCount}/${MAX_PLAYER_CHUTES} · Stickers ${snapshot.stickers.length} → ${preview.resultingStickerCount}/${MAX_STICKERS}`),
        node("p", `Cost ${preview.cost} · Remaining currency ${preview.remainingMoney}`, "shop-balance"));
      const blocker = node("p", preview.blocker ? BLOCKERS[preview.blocker] : "This change applies to the next encounter.");
      blocker.id = "purchase-blocker";
      const buy = action(`Buy ${offer.label}`, () => {
        const result = callbacks.purchase(purchaseRequest);
        notice.textContent = result.success ? `${offer.label} purchased. Your carried build is updated.` : BLOCKERS[result.code];
        if (result.success) {
          const nextBuy = content.querySelector<HTMLButtonElement>(".purchase-preview button");
          const focusTarget = nextBuy && !nextBuy.disabled ? nextBuy
            : content.querySelector<HTMLButtonElement>(`[data-offer="${selectedOffer}"]`);
          focusTarget?.focus({ preventScroll: true });
        }
      }, true);
      buy.disabled = !preview.allowed;
      buy.setAttribute("aria-describedby", blocker.id);
      previewHost.append(blocker, buy);
    }
    chuteSelect.addEventListener("change", () => { selectedChute = chuteSelect.value; refresh(); });
    source.addEventListener("change", () => { replaceType = source.value as CoinType; refresh(); });
    refresh();
    const next = action("Next encounter", () => {
      if (!callbacks.continueRun()) {
        notice.textContent = "The next encounter is not ready. Restart if the machine reported an error.";
      }
    }, true);
    next.id = "next-encounter";
    next.setAttribute("aria-label", `Continue to encounter ${snapshot.encounterIndex + 2}`);
    content.append(form, offers, previewHost);
    navigation.append(review, next);
  }
  return {
    update(snapshot: RunSnapshot): void {
      const previousPhase = current?.phase;
      current = snapshot;
      host.hidden = snapshot.phase === "encounter";
      const key = `${snapshot.phase}/${snapshot.encounterIndex}/${snapshot.purchases.length}`;
      if (key === renderedKey) return;
      renderedKey = key;
      const scrollTop = content.scrollTop;
      content.replaceChildren();
      navigation.replaceChildren();
      notice.textContent = "";
      if (snapshot.phase === "starter") {
        heading.textContent = "Choose your kit";
        starters();
      } else if (snapshot.phase === "shop") {
        heading.textContent = "Machine shop";
        shop(snapshot);
      } else if (snapshot.phase === "won" || snapshot.phase === "lost") {
        heading.textContent = snapshot.phase === "won" ? "Run victory" : "Run defeated";
        content.append(node("p", `${snapshot.completedEncounters}/${snapshot.encounterCount} encounters completed · Currency earned ${snapshot.earnedCurrency} · Spent ${snapshot.spentCurrency} · Carried ${snapshot.currency}`), buildSummary(snapshot), action("New run", callbacks.restart, true));
      } else if (snapshot.phase === "error") {
        heading.textContent = "Run unavailable";
        content.append(node("p", snapshot.error ?? "The encounter could not continue. Restart to try the selected seed again."), action("New run", callbacks.restart, true));
      }
      content.scrollTop = previousPhase === snapshot.phase ? scrollTop : 0;
      if (previousPhase && previousPhase !== snapshot.phase && !host.hidden) heading.focus({ preventScroll: true });
    },
  };
}
