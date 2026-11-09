// @ts-check
/// <reference path="../../usee-plugin-template/sdk/usee-plugin.d.ts" />
// Мониторинг стримов Twitch для Usee (SDK 11).
// Карточки: статус эфира (status), динамика зрителей (spark), сводка (message).

const GQL_ENDPOINT = "https://gql.twitch.tv/gql";
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_HEADERS = {
  "Client-Id": GQL_CLIENT_ID,
  "Content-Type": "application/json",
};

const POPULAR_STREAMERS = [
  { id: "shroud", name: "shroud" },
  { id: "tarik", name: "tarik" },
  { id: "xqcow", name: "xQc" },
  { id: "ibai", name: "ibai" },
  { id: "zxcursed", name: "zxcursed" },
  { id: "bratishkinoff", name: "bratishkinoff" },
  { id: "silvername", name: "SilverName" },
  { id: "stray228", name: "Stray228" },
  { id: "nix", name: "Nix" },
  { id: "evelone192", name: "Evelone192" },
  { id: "dota2ti", name: "dota2ti" },
  { id: "esl_csgo", name: "ESLCS" },
];

function cleanChannel(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/^(https?:\/\/)?([a-z0-9_]+\.)?twitch\.tv\//i, "");
  s = s.replace(/^@/, "");
  s = s.split("/")[0].split("?")[0].trim().toLowerCase();
  return s;
}

function formatViewers(n) {
  if (typeof n !== "number" || isNaN(n) || n <= 0) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 10000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function calcUptime(createdAt) {
  if (!createdAt) return { hours: 0, mins: 0, sec: 0, text: "" };
  const startMs = Date.parse(createdAt);
  if (isNaN(startMs)) return { hours: 0, mins: 0, sec: 0, text: "" };
  const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const text = hours > 0 ? `${hours}ч ${mins}м` : `${mins}м`;
  return { hours, mins, sec, text };
}

const g_encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function utf8Bytes(str) {
  if (!str) return 0;
  if (g_encoder) return g_encoder.encode(str).length;
  return encodeURIComponent(str).replace(/%[A-F\d]{2}/g, "U").length;
}

function truncateUtf8(str, maxBytes) {
  if (!str) return "";
  let s = String(str).trim();
  if (utf8Bytes(s) <= maxBytes) return s;
  const ell = "…";
  const targetBytes = maxBytes - utf8Bytes(ell);
  if (targetBytes <= 0) return ell;
  let chars = Array.from(s);
  if (chars.length > targetBytes) chars = chars.slice(0, targetBytes);
  while (chars.length > 0 && utf8Bytes(chars.join("")) > targetBytes) {
    chars.pop();
  }
  return chars.join("").trim() + ell;
}

function truncateChars(str, maxChars) {
  if (!str) return "";
  const chars = Array.from(String(str).trim());
  if (chars.length <= maxChars) return chars.join("");
  return chars.slice(0, maxChars - 1).join("").trim() + "…";
}

async function fetchGql(channels) {
  if (!channels || channels.length === 0) return {};
  const query = `query($login: String!) {
    user(login: $login) {
      id
      login
      displayName
      stream {
        id
        title
        viewersCount
        createdAt
        game { name }
      }
      lastBroadcast {
        title
        startedAt
      }
    }
  }`;

  const payload = channels.map(login => ({
    query,
    variables: { login }
  }));

  const r = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
  });

  if (!r.ok) throw new Error("Twitch GQL HTTP " + r.status);
  const data = await r.json();

  const results = {};
  const items = Array.isArray(data) ? data : [data];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const u = item && item.data && item.data.user;
    const requested = channels[i];
    if (u) {
      results[u.login.toLowerCase()] = u;
      if (requested && requested !== u.login.toLowerCase()) {
        results[requested] = u;
      }
    } else if (requested) {
      results[requested] = null;
    }
  }

  return results;
}

let cachedHelixToken = null;
let helixTokenExpiresAt = 0;

async function getHelixToken(clientId, clientSecret) {
  const now = Date.now();
  if (cachedHelixToken && now < helixTokenExpiresAt - 60000) {
    return cachedHelixToken;
  }
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) throw new Error("Helix OAuth HTTP " + r.status);
  const data = await r.json();
  if (!data || !data.access_token) throw new Error("нет access_token в ответе Twitch");
  cachedHelixToken = data.access_token;
  helixTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedHelixToken;
}

async function fetchHelix(channels, clientId, clientSecret) {
  const token = await getHelixToken(clientId, clientSecret);
  const headers = {
    "Client-Id": clientId,
    "Authorization": "Bearer " + token,
  };

  const usersUrl = "https://api.twitch.tv/helix/users?" + channels.map(c => `login=${encodeURIComponent(c)}`).join("&");
  const streamsUrl = "https://api.twitch.tv/helix/streams?" + channels.map(c => `user_login=${encodeURIComponent(c)}`).join("&");

  const [usersRes, streamsRes] = await Promise.all([
    fetch(usersUrl, { headers }),
    fetch(streamsUrl, { headers })
  ]);

  if (!usersRes.ok) throw new Error("Helix Users HTTP " + usersRes.status);
  if (!streamsRes.ok) throw new Error("Helix Streams HTTP " + streamsRes.status);

  const usersJson = await usersRes.json();
  const streamsJson = await streamsRes.json();

  const usersList = (usersJson && Array.isArray(usersJson.data)) ? usersJson.data : [];
  const streamsList = (streamsJson && Array.isArray(streamsJson.data)) ? streamsJson.data : [];

  const streamsByLogin = {};
  for (const s of streamsList) {
    if (s && s.user_login) {
      streamsByLogin[s.user_login.toLowerCase()] = s;
    }
  }

  const results = {};
  for (const u of usersList) {
    const login = u.login.toLowerCase();
    const st = streamsByLogin[login];
    results[login] = {
      id: u.id,
      login: u.login,
      displayName: u.display_name || u.login,
      stream: st ? {
        id: st.id,
        title: st.title || "",
        viewersCount: st.viewer_count || 0,
        createdAt: st.started_at,
        game: { name: st.game_name || "" },
      } : null,
      lastBroadcast: null,
    };
  }

  for (const ch of channels) {
    if (!(ch in results)) results[ch] = null;
  }

  return results;
}

definePlugin({
  cards: {
    stream: { label: "Стрим (stream)", type: "status" },
    viewers: { label: "Зрители (viewers)", type: "spark" },
    card: { label: "Сводка (message)", type: "message" },
  },

  providers: {
    async searchChannel(ctx, form) {
      const q = cleanChannel(form && form.channel);
      if (q.length < 2) {
        return POPULAR_STREAMERS.map(s => ({
          id: s.id,
          label: s.name,
          detail: "Twitch",
        }));
      }

      try {
        const query = `query($q: String!) {
          searchSuggestions(queryFragment: $q) {
            edges { node { text } }
          }
        }`;
        const r = await fetch(GQL_ENDPOINT, {
          method: "POST",
          headers: GQL_HEADERS,
          body: JSON.stringify({ query, variables: { q } })
        });
        if (r.ok) {
          const res = await r.json();
          const edges = res && res.data && res.data.searchSuggestions && res.data.searchSuggestions.edges;
          if (Array.isArray(edges) && edges.length > 0) {
            return edges.map(e => ({
              id: e.node.text,
              label: e.node.text,
              detail: "Twitch",
            }));
          }
        }
      } catch (err) {
        ctx.log.warn("Twitch search error: " + err);
      }

      return POPULAR_STREAMERS
        .filter(s => s.id.includes(q) || s.name.toLowerCase().includes(q))
        .map(s => ({ id: s.id, label: s.name, detail: "Twitch" }));
    }
  },

  activate(ctx) {
    const clientId = String(ctx.settings.get("clientId") || "").trim();
    const clientSecret = String(ctx.settings.get("clientSecret") || "").trim();
    const useHelix = Boolean(clientId && clientSecret);
    const intervalSec = Math.max(10, Math.min(300, Number(ctx.settings.get("intervalSec")) || 30));

    // Сбор активных каналов и объявление сущностей для шины данных
    const activeInstances = [];
    const entities = [];

    ctx.instances.each(inst => {
      activeInstances.push(inst);
      const prefix = inst.id && inst.id !== "1" ? `${inst.id}.` : "";
      const chName = inst.name || inst.settings.get("channel") || inst.id;
      const suffix = chName ? ` (${chName})` : "";

      entities.push(
        { id: `${prefix}online`, label: `В эфире${suffix}`, kind: "bool" },
        { id: `${prefix}viewers`, label: `Зрители${suffix}`, kind: "number", unit: "зрит." },
        { id: `${prefix}game`, label: `Категория / Игра${suffix}`, kind: "string" },
        { id: `${prefix}title`, label: `Название стрима${suffix}`, kind: "string" },
        { id: `${prefix}uptime_sec`, label: `Время в эфире${suffix}`, kind: "number", unit: "с" }
      );
    });

    ctx.entities.declare(entities);

    // Локальная история зрителей для кривой spark (до 90 точек)
    const viewerHistories = {};

    // Кэшированный пакетный опрос каналов
    let cachedResults = null;
    let lastFetchAt = 0;
    let pendingFetch = null;

    async function fetchAllChannels() {
      const now = Date.now();
      if (cachedResults && (now - lastFetchAt < (intervalSec / 2) * 1000)) {
        return cachedResults;
      }
      if (pendingFetch) return pendingFetch;

      pendingFetch = (async () => {
        try {
          const channels = Array.from(new Set(
            activeInstances
              .map(i => cleanChannel(i.settings.get("channel")))
              .filter(Boolean)
          ));

          if (channels.length === 0) {
            cachedResults = {};
            lastFetchAt = Date.now();
            return cachedResults;
          }

          const res = useHelix
            ? await fetchHelix(channels, clientId, clientSecret)
            : await fetchGql(channels);

          cachedResults = res;
          lastFetchAt = Date.now();
          return res;
        } catch (err) {
          ctx.log.warn("Twitch fetch error: " + err);
          if (cachedResults) return cachedResults;
          throw err;
        } finally {
          pendingFetch = null;
        }
      })();

      return pendingFetch;
    }

    ctx.instances.each(inst => {
      inst.poll(async () => {
        const rawChannel = inst.settings.get("channel");
        const channel = cleanChannel(rawChannel);

        if (!channel) {
          inst.cards.stream.remove();
          inst.cards.viewers.remove();
          inst.cards.card.remove();
          throw new Error("канал не указан");
        }

        const allResults = await fetchAllChannels();
        const user = allResults[channel];

        if (!user) {
          inst.cards.stream.remove();
          inst.cards.viewers.remove();
          inst.cards.card.remove();
          throw new Error("канал не найден: " + channel);
        }

        const displayName = user.displayName || channel;
        const stream = user.stream;
        const isOnline = Boolean(stream);

        const viewers = isOnline ? (stream.viewersCount || 0) : 0;
        const game = isOnline ? ((stream.game && stream.game.name) || "") : "";
        const title = isOnline ? (stream.title || "") : ((user.lastBroadcast && user.lastBroadcast.title) || "");
        const uptime = isOnline ? calcUptime(stream.createdAt) : { hours: 0, mins: 0, sec: 0, text: "" };

        // 1. Карточка STREAM (status)
        if (isOnline) {
          const startMs = Date.parse(stream.createdAt);
          const eventAt = !isNaN(startMs) ? Math.floor(startMs / 1000) : undefined;
          inst.cards.stream.set({
            icon: "record",
            line1: truncateUtf8(`${displayName} · ${formatViewers(viewers)} зрит.`, 39),
            line2: truncateUtf8(game ? `${game} · ${uptime.text}` : uptime.text, 71),
            badge: "LIVE",
            badgeKind: "accent",
            eventAt,
            detail: truncateUtf8(title || displayName, 39),
          });
        } else {
          inst.cards.stream.set({
            icon: "pause",
            line1: truncateUtf8(`${displayName} · ОФФЛАЙН`, 39),
            line2: truncateUtf8(title ? `Был: ${title}` : "Канал оффлайн", 71),
            badge: "ОФФЛАЙН",
            badgeKind: "plain",
            detail: "Стрим сейчас не идёт",
          });
        }

        // 2. Карточка VIEWERS (spark)
        let sparkNum = viewers;
        let sparkUnit = "";
        if (viewers >= 1000000) {
          sparkNum = Math.min(32767, Math.round(viewers / 1000000));
          sparkUnit = "M";
        } else if (viewers >= 1000) {
          sparkNum = Math.min(32767, Math.round(viewers / 1000));
          sparkUnit = "k";
        }
        inst.cards.viewers.set({
          label: truncateUtf8(displayName.toUpperCase(), 19),
          number: sparkNum,
          unit: sparkUnit,
          windowSec: isOnline ? 3600 : 0,
        });

        // Обновление кривой истории зрителей
        let hist = viewerHistories[inst.id];
        if (!hist) {
          hist = [];
          viewerHistories[inst.id] = hist;
        }
        hist.push(viewers);
        if (hist.length > 90) hist.shift();

        const minV = Math.min(...hist);
        const maxV = Math.max(...hist);
        const rangeV = maxV - minV;
        const pt = isOnline
          ? (rangeV > 0 ? Math.max(0, Math.min(255, Math.round(((viewers - minV) / rangeV) * 255))) : 128)
          : 0;
        inst.cards.viewers.history(pt);

        // 3. Карточка CARD (message)
        if (isOnline) {
          let vStr, uStr;
          if (viewers >= 1000000) {
            vStr = (viewers / 1000000).toFixed(1);
            uStr = "M";
          } else if (viewers >= 1000) {
            vStr = viewers >= 10000 ? Math.round(viewers / 1000).toString() : (viewers / 1000).toFixed(1);
            uStr = "k";
          } else {
            vStr = String(viewers);
            uStr = "зрит";
          }
          const n2 = uptime.hours > 0 ? String(uptime.hours) : String(uptime.mins);
          const u2 = uptime.hours > 0 ? `ч ${uptime.mins}м` : "мин";

          inst.cards.card.set({
            title: truncateChars(displayName.toUpperCase(), 30),
            titleShort: "TWITCH",
            tone: "good",
            icon: "monitor",
            num: vStr,
            unit: uStr,
            num2: n2,
            unit2: u2,
            expl: truncateChars(game || title || "В эфире", 24),
            progress: 100,
          });
        } else {
          inst.cards.card.set({
            title: truncateChars(displayName.toUpperCase(), 30),
            titleShort: "TWITCH",
            tone: "neutral",
            icon: "monitor",
            num: "ОФФ",
            unit: "ЛАЙН",
            num2: "",
            unit2: "",
            expl: truncateChars(title ? `Был: ${title}` : "Канал оффлайн", 24),
            progress: 0,
          });
        }

        // Обновление сущностей шины данных
        const prefix = inst.id && inst.id !== "1" ? `${inst.id}.` : "";
        ctx.entities.setMany({
          [`${prefix}online`]: isOnline,
          [`${prefix}viewers`]: viewers,
          [`${prefix}game`]: game,
          [`${prefix}title`]: title,
          [`${prefix}uptime_sec`]: uptime.sec,
        });

        return isOnline
          ? `${displayName}: LIVE (${formatViewers(viewers)})`
          : `${displayName}: оффлайн`;
      }, { everySec: intervalSec });
    });
  }
});
