// @ts-check
/// <reference path="../../usee-plugin-template/sdk/usee-plugin.d.ts" />
// Котировки криптовалют для Usee (SDK 11) — CoinGecko API (бесплатно, без ключа).
// Карточки: «котировка» (message), «тикер» (status) и «график 24ч» (spark).

const API_ROOT = "https://api.coingecko.com/api/v3";
const HEADERS = { "User-Agent": "Usee/1.0" };

const POPULAR_COINS = [
  { id: "bitcoin", name: "Bitcoin", symbol: "BTC" },
  { id: "ethereum", name: "Ethereum", symbol: "ETH" },
  { id: "solana", name: "Solana", symbol: "SOL" },
  { id: "the-open-network", name: "Toncoin", symbol: "TON" },
  { id: "binancecoin", name: "BNB", symbol: "BNB" },
  { id: "ripple", name: "XRP", symbol: "XRP" },
  { id: "dogecoin", name: "Dogecoin", symbol: "DOGE" },
  { id: "cardano", name: "Cardano", symbol: "ADA" },
  { id: "avalanche-2", name: "Avalanche", symbol: "AVAX" },
  { id: "polkadot", name: "Polkadot", symbol: "DOT" },
  { id: "chainlink", name: "Chainlink", symbol: "LINK" },
  { id: "near", name: "NEAR Protocol", symbol: "NEAR" },
  { id: "sui", name: "Sui", symbol: "SUI" },
  { id: "litecoin", name: "Litecoin", symbol: "LTC" },
];

const ALIASES = {
  "btc": "bitcoin",
  "bitcoin": "bitcoin",
  "биткоин": "bitcoin",
  "биткойн": "bitcoin",
  "eth": "ethereum",
  "ethereum": "ethereum",
  "эфир": "ethereum",
  "эфириум": "ethereum",
  "sol": "solana",
  "solana": "solana",
  "солана": "solana",
  "ton": "the-open-network",
  "toncoin": "the-open-network",
  "тон": "the-open-network",
  "тонкоин": "the-open-network",
  "the-open-network": "the-open-network",
  "bnb": "binancecoin",
  "binancecoin": "binancecoin",
  "xrp": "ripple",
  "ripple": "ripple",
  "doge": "dogecoin",
  "dogecoin": "dogecoin",
  "доги": "dogecoin",
  "догикоин": "dogecoin",
  "ada": "cardano",
  "cardano": "cardano",
  "avax": "avalanche-2",
  "avalanche": "avalanche-2",
  "dot": "polkadot",
  "polkadot": "polkadot",
  "link": "chainlink",
  "chainlink": "chainlink",
  "near": "near",
  "sui": "sui",
  "ltc": "litecoin",
  "litecoin": "litecoin",
};

const CURRENCY_SYMBOLS = {
  "usd": "$",
  "eur": "€",
  "rub": "₽",
};

function currencySign(cur) {
  return CURRENCY_SYMBOLS[String(cur || "").toLowerCase()] || "$";
}

function formatPrice(p) {
  if (typeof p !== "number" || isNaN(p)) return "—";
  if (p >= 1000) {
    const rounded = Math.round(p);
    return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }
  if (p >= 10) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}

function formatShortNum(p, sym) {
  if (typeof p !== "number" || isNaN(p)) return "—";
  const s = sym || "";
  if (p >= 1000000) return s + (p / 1000000).toFixed(1) + "M";
  if (p >= 1000) return s + (p / 1000).toFixed(1) + "k";
  if (p >= 1) return s + p.toFixed(1);
  return s + p.toFixed(3);
}

function formatVolume(v, sym) {
  if (typeof v !== "number" || isNaN(v)) return "";
  const s = sym || "";
  if (v >= 1e9) return s + (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return s + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return s + (v / 1e3).toFixed(0) + "k";
  return s + Math.round(v);
}

async function searchCoinGecko(q) {
  const r = await fetch(`${API_ROOT}/search?query=${encodeURIComponent(q)}`, { headers: HEADERS });
  if (!r.ok) throw new Error("search: HTTP " + r.status);
  const data = await r.json();
  return (data && Array.isArray(data.coins)) ? data.coins : [];
}

async function resolveCoin(ctx, raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "bitcoin";

  if (ALIASES[key]) return ALIASES[key];

  const cached = ctx.storage.get("id:" + key);
  if (typeof cached === "string" && cached.length > 0) return cached;

  try {
    const list = await searchCoinGecko(key);
    if (list.length > 0) {
      const best = list[0].id;
      ctx.storage.set("id:" + key, best);
      return best;
    }
  } catch (err) {
    ctx.log.warn("ошибка поиска монеты " + key + ": " + err);
  }

  return key;
}

async function fetchMarkets(ids, currency) {
  const url = `${API_ROOT}/coins/markets?vs_currency=${encodeURIComponent(currency)}&ids=${encodeURIComponent(ids.join(","))}&sparkline=true&price_change_percentage=24h`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error("markets: HTTP " + r.status);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("неверный ответ markets");
  return data;
}

definePlugin({
  cards: {
    quote: { label: "Котировка (quote)", type: "message" },
    ticker: { label: "Тикер (ticker)", type: "status" },
    chart: { label: "График 24ч (chart)", type: "spark" },
  },

  activate(ctx) {
    const currency = String(ctx.settings.get("currency") || "usd").toLowerCase();
    const sym = currencySign(currency);
    const intervalMin = Math.max(1, Number(ctx.settings.get("intervalMin")) || 2);

    // Собираем ссылки на все активные экземпляры
    const activeInstances = [];
    const entitiesList = [];

    ctx.instances.each(inst => {
      activeInstances.push(inst);
      const prefix = inst.id && inst.id !== "1" ? `crypto.${inst.id}.` : "crypto.";
      const nameSuffix = inst.name ? ` (${inst.name})` : "";
      entitiesList.push(
        { id: `${prefix}price`, label: `Цена${nameSuffix}`, kind: "number", unit: sym },
        { id: `${prefix}change_24h`, label: `Изменение 24ч${nameSuffix}`, kind: "number", unit: "%" },
        { id: `${prefix}high_24h`, label: `Максимум 24ч${nameSuffix}`, kind: "number", unit: sym },
        { id: `${prefix}low_24h`, label: `Минимум 24ч${nameSuffix}`, kind: "number", unit: sym },
        { id: `${prefix}volume`, label: `Объём 24ч${nameSuffix}`, kind: "number", unit: sym }
      );
    });
    ctx.entities.declare(entitiesList);

    // Кэш рынка для пакетных запросов
    let cachedMarkets = null;
    let lastMarketsFetchAt = 0;
    let pendingFetch = null;

    async function getMarkets() {
      const now = Date.now();
      if (cachedMarkets && (now - lastMarketsFetchAt < 30000)) {
        return cachedMarkets;
      }
      if (pendingFetch) return pendingFetch;

      pendingFetch = (async () => {
        try {
          const coinPromises = activeInstances.map(i => resolveCoin(ctx, i.settings.get("coin")));
          const resolved = await Promise.all(coinPromises);
          const coinIds = Array.from(new Set(resolved.filter(Boolean)));
          const list = await fetchMarkets(coinIds.length > 0 ? coinIds : ["bitcoin"], currency);
          cachedMarkets = list;
          lastMarketsFetchAt = Date.now();
          ctx.storage.set("cache_markets", list);
          return list;
        } catch (err) {
          ctx.log.warn("ошибка загрузки рынка: " + err);
          const fromStore = ctx.storage.get("cache_markets");
          if (Array.isArray(fromStore) && fromStore.length > 0) {
            return fromStore;
          }
          throw err;
        } finally {
          pendingFetch = null;
        }
      })();

      return pendingFetch;
    }

    ctx.instances.each(inst => {
      inst.poll(async () => {
        const rawCoin = String(inst.settings.get("coin") || "bitcoin").trim();
        const resolvedId = await resolveCoin(ctx, rawCoin);

        const marketList = await getMarkets();
        const coin = marketList.find(c => c && (c.id === resolvedId || String(c.symbol || "").toLowerCase() === resolvedId.toLowerCase()));

        if (!coin) {
          inst.cards.quote.remove();
          inst.cards.ticker.remove();
          inst.cards.chart.remove();
          throw new Error("монета не найдена: " + rawCoin);
        }

        const price = coin.current_price;
        const change24 = typeof coin.price_change_percentage_24h === "number"
          ? coin.price_change_percentage_24h
          : 0;
        const high24 = coin.high_24h ?? price;
        const low24 = coin.low_24h ?? price;
        const vol24 = coin.total_volume ?? 0;
        const ticker = String(coin.symbol || resolvedId).toUpperCase();
        const coinName = String(coin.name || ticker).toUpperCase();
        const priceStr = formatPrice(price);
        const changeStr = (change24 >= 0 ? "+" : "") + change24.toFixed(1) + "%";
        const signChange = (change24 >= 0 ? "+" : "") + change24.toFixed(1);

        // Положение цены в диапазоне суток 0..100%
        const rangeSpread = high24 - low24;
        const rangeProgress = rangeSpread > 0
          ? Math.max(0, Math.min(100, Math.round(((price - low24) / rangeSpread) * 100)))
          : 50;

        // 1. Карточка «Котировка» (message)
        const explText = `H: ${formatShortNum(high24, sym)} · L: ${formatShortNum(low24, sym)}`;

        inst.cards.quote.set({
          title: `${coinName} (${ticker})`,
          titleShort: ticker,
          tone: change24 >= 0 ? "good" : "problem",
          num: priceStr,
          unit: sym,
          num2: signChange,
          unit2: "%",
          progress: rangeProgress,
          expl: explText.length <= 24 ? explText : `${formatShortNum(low24, sym)}…${formatShortNum(high24, sym)}`,
        });

        // 2. Карточка «Тикер» (status)
        const line2Variants = [
          `24ч: ${changeStr} · H: ${formatShortNum(high24, sym)} · L: ${formatShortNum(low24, sym)}`,
          `24ч: ${changeStr} · ${formatShortNum(low24, sym)}…${formatShortNum(high24, sym)}`,
          `24ч: ${changeStr}`,
        ];

        inst.cards.ticker.set({
          icon: "sparkle",
          line1: `${ticker} · ${sym}${priceStr}`,
          state: priceStr,
          number: price,
          badge: changeStr,
          badgeKind: change24 >= 0 ? "accent" : "plain",
          line2: line2Variants,
          detail: vol24 > 0 ? `Объём 24ч: ${formatVolume(vol24, sym)}` : undefined,
        });

        // 3. Карточка «График 24ч» (spark)
        const sparkPrices = Array.isArray(coin.sparkline_in_7d?.price)
          ? coin.sparkline_in_7d.price.slice(-24)
          : [];

        // Для цены >= 30000 масштабируем в тысячи (k$), чтобы не выйти за int16_t (32767)
        const isThousands = price >= 30000;
        const sparkNum = isThousands ? Math.round(price / 1000) : Math.round(price);
        const sparkUnit = isThousands ? `k${sym}` : sym;

        inst.cards.chart.set({
          label: `${ticker}/${currency.toUpperCase()}`,
          number: sparkNum,
          unit: sparkUnit,
          windowSec: 86400,
        });

        if (sparkPrices.length > 0) {
          let minP = sparkPrices[0], maxP = sparkPrices[0];
          for (const p of sparkPrices) {
            if (p < minP) minP = p;
            if (p > maxP) maxP = p;
          }
          const span = maxP - minP;
          for (const p of sparkPrices) {
            const pt = span > 0
              ? Math.max(0, Math.min(255, Math.round(((p - minP) / span) * 255)))
              : 128;
            inst.cards.chart.history(pt);
          }
        }

        // 4. Сущности в шину
        const prefix = inst.id && inst.id !== "1" ? `crypto.${inst.id}.` : "crypto.";
        ctx.entities.setMany({
          [`${prefix}price`]: price,
          [`${prefix}change_24h`]: change24,
          [`${prefix}high_24h`]: high24,
          [`${prefix}low_24h`]: low24,
          [`${prefix}volume`]: vol24,
        });

        return `${ticker}: ${sym}${priceStr} (${changeStr})`;
      }, { everySec: intervalMin * 60 });
    });
  },

  providers: {
    async searchCoin(ctx, form) {
      const q = String((form && form.coin) || "").trim().toLowerCase();
      if (q.length < 2) {
        return POPULAR_COINS.map(c => ({
          id: c.id,
          label: `${c.name} (${c.symbol})`,
          detail: c.symbol,
        }));
      }

      // Сначала проверяем точные синонимы/тикеры
      if (ALIASES[q]) {
        const id = ALIASES[q];
        const pop = POPULAR_COINS.find(p => p.id === id);
        return [{
          id,
          label: pop ? `${pop.name} (${pop.symbol})` : id,
          detail: q.toUpperCase(),
        }];
      }

      try {
        const list = await searchCoinGecko(q);
        return list.slice(0, 8).map(c => ({
          id: c.id,
          label: `${c.name} (${String(c.symbol || "").toUpperCase()})`,
          detail: c.market_cap_rank ? `#${c.market_cap_rank}` : "",
        }));
      } catch (err) {
        ctx.log.warn("searchCoin error: " + err);
        return POPULAR_COINS
          .filter(c => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q))
          .map(c => ({
            id: c.id,
            label: `${c.name} (${c.symbol})`,
            detail: c.symbol,
          }));
      }
    },
  },
});
