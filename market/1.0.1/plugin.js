// Рынок для Usee — цены криптовалют и 24-часовое изменение (CoinGecko, бесплатно,
// без ключа). Публикует две карточки: gauge с ценой основной монеты в выбранной
// валюте и status со строкой изменений всего списка. Какие ставить на экран —
// человек в раскладке сцен; плагин просто обновляет обе.

const API = "https://api.coingecko.com/api/v3/simple/price";

// id CoinGecko → короткая метка для экрана (иконок-валют в встроенном наборе
// нет — берём тикер, он и так читается на карточке).
const TAG = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", binancecoin: "BNB",
  cardano: "ADA", ripple: "XRP", litecoin: "LTC", dogecoin: "DOGE",
  polkadot: "DOT", avalanche: "AVAX", chainlink: "LINK",
};

function tag(id) { return TAG[id] || id.slice(0, 4).toUpperCase(); }

// +2.4 → "+2,4%"; -1.06 → "-1,1%".
function pct(n) {
  n = Number(n) || 0;
  const s = Math.abs(n).toFixed(1).replace(".", ",");
  return (n >= 0 ? "+" : "-") + s + "%";
}

definePlugin({
  cards: {
    price: { label: "Рынок · цена", type: "gauge" },
    chg: { label: "Рынок · 24ч", type: "status" },
  },

  activate(ctx) {
    const primary = String(ctx.settings.get("primary") || "bitcoin").trim().toLowerCase();
    const cur = String(ctx.settings.get("currency") || "usd").trim().toLowerCase();
    const label = String(ctx.settings.get("label") || tag(primary)).toUpperCase();

    const symbols = [];
    for (const part of String(ctx.settings.get("symbols") || "bitcoin,ethereum,solana").split(",")) {
      const id = part.trim().toLowerCase();
      if (id && symbols.indexOf(id) < 0) symbols.push(id);
    }
    if (symbols.indexOf(primary) < 0) symbols.unshift(primary);

    ctx.poll(async () => {
      const r = await fetch(`${API}?ids=${symbols.join(",")}&vs_currencies=${cur}&include_24hr_change=true`);
      if (!r.ok) throw new Error("CoinGecko: HTTP " + r.status);
      const data = await r.json();
      const main = data[primary];
      if (!main || typeof main[cur] !== "number") throw new Error("нет цены: " + primary);

      ctx.cards.price.set({
        label, number: main[cur], state: String(main[cur]), unit: cur.toUpperCase(),
      });

      const parts = [];
      for (const id of symbols) {
        const d = data[id];
        parts.push(tag(id) + " " + (d ? pct(d[cur + "_24h_change"]) : "—"));
      }
      const chg = Number(main[cur + "_24h_change"]) || 0;
      ctx.cards.chg.set({
        icon: "bolt", line1: label + " · 24Ч", line2: parts.join("  "),
        badge: pct(chg), badgeKind: chg >= 0 ? "accent" : "plain",
        number: chg, state: pct(chg),
      });

      return tag(primary) + " " + main[cur] + " " + cur.toUpperCase() + " (" + pct(chg) + ")";
    }, { everySec: 60 * ctx.settings.get("intervalMin") });
  },
});
