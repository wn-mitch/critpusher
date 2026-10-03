import type { CoinType } from "../contracts";
import { coinSymbolMarkup } from "../presentation/coin-symbols";
import type { OfferId } from "../run/types";

const COIN_OFFERS: Partial<Record<OfferId, CoinType>> = {
  "sword-pack": "sword",
  "potion-pack": "potion",
  "gold-pack": "gold",
  "diamond-mint": "diamond",
  "tempered-swords": "sword",
  "restorative-brew": "potion",
};
const MECHANICAL_SYMBOLS: Partial<Record<OfferId, string>> = {
  "extra-chute": '<path d="M5 3h14v12l-7 6-7-6V3Zm4 4h6M9 11h6M12 15v4M3 8H1m1-1v2"/>',
  "collected-only": '<path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  miniature: '<circle cx="7" cy="8" r="4"/><circle cx="17" cy="7" r="3"/><circle cx="16" cy="17" r="3"/><circle cx="6" cy="18" r="2"/>',
  "magazine-dump": '<path d="M4 3h16M5 6h14M6 9h12M7 12h10M8 15h8M12 17v5m-4-4 4 4 4-4"/>',
  "combo-bell": '<path d="M5 17h14l-2-4V9a5 5 0 0 0-10 0v4l-2 4ZM10 20h4M12 2V1M3 5 1 3m20 2 2-2"/>',
};

export function offerIcon(id: OfferId): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "offer-icon";
  icon.setAttribute("aria-hidden", "true");
  const coin = COIN_OFFERS[id];
  icon.innerHTML = coin ? coinSymbolMarkup(coin)
    : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MECHANICAL_SYMBOLS[id]}</svg>`;
  if (id === "tempered-swords" || id === "restorative-brew") {
    const upgrade = document.createElement("span");
    upgrade.className = "offer-icon-upgrade";
    upgrade.textContent = "+";
    icon.append(upgrade);
  }
  return icon;
}
