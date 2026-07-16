// Discord для Usee — голосовой канал как карточка: ростер, «кто говорит»
// (мгновенно, через patch immediate), аватарки, рамка при локальном говорении.
// Паритет с нативным DiscordSource: перебор discord-ipc-0..9, HANDSHAKE →
// READY → AUTHENTICATE (кэш-токен в ctx.secrets) / AUTHORIZE → обмен кода на
// discord.com (публичный клиент; verifier по PKCE-plain — в песочнице нет
// SHA-256) → подписки на войс-события выбранного канала.
const OP_HANDSHAKE = 0, OP_FRAME = 1, OP_CLOSE = 2;
const CLIENT_ID = "1523669931957293056";
const SCOPES = ["rpc", "rpc.voice.read"];
const REDIRECT_URI = "http://localhost";
const RECONNECT_MS = 5000;
const KEEPALIVE_MS = 10000;   // re-upsert пока в войсе (staleness 20 с)
const STALE_SEC = 20;

// ---- фрейминг: [op:4 LE][len:4 LE][utf8 json] (копия шаблонного хелпера) ----

function writeU32LE(a, at, v) {
  a[at] = v & 255; a[at + 1] = (v >> 8) & 255; a[at + 2] = (v >> 16) & 255; a[at + 3] = (v >> 24) & 255;
}
function readU32LE(a, at) {
  return a[at] | (a[at + 1] << 8) | (a[at + 2] << 16) | (a[at + 3] << 24);
}
function utf8Encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}
function utf8Decode(a) {
  let s = "";
  for (let i = 0; i < a.length; ) {
    const b = a[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 31) << 6) | (a[i + 1] & 63); i += 2; }
    else if (b < 0xf0) { cp = ((b & 15) << 12) | ((a[i + 1] & 63) << 6) | (a[i + 2] & 63); i += 3; }
    else { cp = ((b & 7) << 18) | ((a[i + 1] & 63) << 12) | ((a[i + 2] & 63) << 6) | (a[i + 3] & 63); i += 4; }
    s += String.fromCodePoint(cp);
  }
  return s;
}
function encodeFrame(op, body) {
  const payload = utf8Encode(JSON.stringify(body));
  const out = new Uint8Array(8 + payload.length);
  writeU32LE(out, 0, op);
  writeU32LE(out, 4, payload.length);
  out.set(payload, 8);
  return out;
}
function frameReader(onFrame) {
  let buf = new Uint8Array(0);
  return chunk => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
    for (;;) {
      if (buf.length < 8) return;
      const op = readU32LE(buf, 0);
      const len = readU32LE(buf, 4);
      if (buf.length < 8 + len) return;
      const body = utf8Decode(buf.subarray(8, 8 + len));
      buf = buf.slice(8 + len);
      onFrame(op, JSON.parse(body));
    }
  };
}

definePlugin({
  activate(ctx) {
    // ---- состояние войса ----
    let pipe = null;
    let selfId = null;
    let channelId = null;
    let channelName = "";
    let order = [];              // userIds в порядке входа
    const members = {};          // id → {name, hash, speaking, iconKey|null}
    const pending = {};          // nonce → колбэк ответа
    const avatars = {};          // "id/hash" → "pending" | iconKey | "fail"
    let nonceN = 0;
    let generation = 0;
    let reconnectTimer = -1;
    let stopped = false;

    ctx.cards.declare([{ id: "voice", label: "Discord — голосовой канал", type: "voice" }]);
    declareContext();

    // ---- подключение: кандидаты по одному, не блокируя очередь ----

    function connect(candidate) {
      if (stopped) return;
      if (candidate > 9) {
        ctx.status.set("warn", "Discord не запущен");
        scheduleReconnect();
        return;
      }
      let p;
      try { p = ctx.pipe.connect("discord-ipc-" + candidate); }
      catch (e) {
        ctx.timers.setTimeout(() => connect(candidate + 1), 30);
        return;
      }
      session(p);
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer !== -1) return;
      reconnectTimer = ctx.timers.setTimeout(() => {
        reconnectTimer = -1;
        connect(0);
      }, RECONNECT_MS);
    }

    function session(p) {
      const gen = ++generation;
      pipe = p;
      const rx = frameReader((op, body) => { if (gen === generation) onFrame(op, body); });
      p.on("data", chunk => rx(chunk));
      p.on("close", why => {
        if (gen !== generation) return;
        ctx.log.info("пайп закрыт: " + why);
        cleanupCall();
        pipe = null;
        scheduleReconnect();
      });
      p.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
    }

    function send(cmd, args, evt, cb) {
      const nonce = "n" + (++nonceN);
      if (cb) pending[nonce] = cb;
      const body = evt ? { cmd, args, evt, nonce } : { cmd, args, nonce };
      pipe.write(encodeFrame(OP_FRAME, body));
    }

    function onFrame(op, body) {
      if (op === OP_CLOSE) { try { pipe.close(); } catch { } return; }
      if (op !== OP_FRAME) return;
      const { cmd, evt, nonce, data } = body;

      if (nonce && pending[nonce]) {
        const cb = pending[nonce];
        delete pending[nonce];
        cb(evt === "ERROR" ? (data && data.message) || "ERROR" : null, data);
        return;
      }
      if (cmd === "DISPATCH" && evt === "READY") {
        selfId = data && data.user ? String(data.user.id) : null;
        authenticate();
        return;
      }
      if (cmd === "DISPATCH" && evt) dispatchEvent(evt, data || {});
    }

    // ---- OAuth: кэш в ctx.secrets → AUTHENTICATE; иначе AUTHORIZE+обмен ----

    function authenticate() {
      const access = ctx.secrets.get("access");
      const expiresAt = Number(ctx.secrets.get("expiresAt") || 0);
      if (access && expiresAt > Date.now() + 60000) {
        send("AUTHENTICATE", { access_token: access }, null, err => {
          if (err) { ctx.log.warn("AUTHENTICATE: " + err); authorizeFlow(); }
          else subscribeVoice();
        });
        return;
      }
      const refresh = ctx.secrets.get("refresh");
      if (refresh) {
        exchange({ grant_type: "refresh_token", refresh_token: refresh })
          .then(token => send("AUTHENTICATE", { access_token: token }, null, err => {
            if (err) authorizeFlow(); else subscribeVoice();
          }))
          .catch(() => authorizeFlow());
        return;
      }
      authorizeFlow();
    }

    function authorizeFlow() {
      // PKCE-plain: в песочнице нет SHA-256 (метод S256 недоступен); при отказе
      // Discord повторяем без challenge — «public»-стратегия нативного пути.
      let verifier = "";
      for (let i = 0; i < 64; i++) verifier += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)];
      const withChallenge = {
        client_id: CLIENT_ID, scopes: SCOPES,
        code_challenge: verifier, code_challenge_method: "plain",
      };
      send("AUTHORIZE", withChallenge, null, (err, data) => {
        if (err || !data || !data.code) {
          ctx.log.warn("AUTHORIZE(pkce-plain): " + (err || "нет кода") + " — пробуем без challenge");
          send("AUTHORIZE", { client_id: CLIENT_ID, scopes: SCOPES }, null, (err2, data2) => {
            if (err2 || !data2 || !data2.code) {
              ctx.status.set("error", "авторизация отклонена: " + (err2 || "нет кода"));
              return;
            }
            exchangeCode(data2.code, null);
          });
          return;
        }
        exchangeCode(data.code, verifier);
      });
    }

    function exchangeCode(code, verifier) {
      const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI };
      if (verifier) form.code_verifier = verifier;
      exchange(form)
        .then(token => send("AUTHENTICATE", { access_token: token }, null, err => {
          if (err) ctx.status.set("error", "AUTHENTICATE: " + err);
          else subscribeVoice();
        }))
        .catch(e => ctx.status.set("error", "обмен кода: " + e));
    }

    // POST на discord.com/api/oauth2/token (public client). Токены → ctx.secrets.
    function exchange(form) {
      form.client_id = CLIENT_ID;
      const body = Object.keys(form)
        .map(k => k + "=" + encodeURIComponent(form[k]))
        .join("&");
      return ctx.net.fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }).then(r => {
        if (!r.ok) throw "HTTP " + r.status + " " + String(r.text).slice(0, 120);
        const j = r.json();
        if (!j || !j.access_token) throw "нет access_token";
        ctx.secrets.set("access", String(j.access_token));
        if (j.refresh_token) ctx.secrets.set("refresh", String(j.refresh_token));
        ctx.secrets.set("expiresAt", String(Date.now() + (Number(j.expires_in) || 3600) * 1000));
        return String(j.access_token);
      });
    }

    // ---- войс: подписки, ростер, события ----

    function subscribeVoice() {
      ctx.status.set("ok", "подключено");
      send("SUBSCRIBE", {}, "VOICE_CHANNEL_SELECT", () => { });
      send("GET_SELECTED_VOICE_CHANNEL", {}, null, (err, data) => {
        if (!err) enterChannel(data);
      });
    }

    function enterChannel(data) {
      cleanupCall();
      const id = data && typeof data.id === "string" ? data.id : null;
      if (!id) { publish(); return; }
      channelId = id;
      channelName = data.name ? String(data.name) : "";
      if (Array.isArray(data.voice_states))
        for (const vs of data.voice_states) upsertVoiceState(vs);
      for (const evt of ["SPEAKING_START", "SPEAKING_STOP",
                         "VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE"])
        send("SUBSCRIBE", { channel_id: id }, evt, () => { });
      declareContext();
      publish();
      ctx.log.info("в канале " + (channelName || id) + ": " + order.length);
    }

    function dispatchEvent(evt, d) {
      switch (evt) {
        case "VOICE_CHANNEL_SELECT":
          if (d.channel_id) send("GET_SELECTED_VOICE_CHANNEL", {}, null, (err, data) => { if (!err) enterChannel(data); });
          else { cleanupCall(); declareContext(); publish(); }
          return;
        case "SPEAKING_START":
        case "SPEAKING_STOP": {
          const id = d.user_id ? String(d.user_id) : "";
          const m = members[id];
          if (m) m.speaking = evt === "SPEAKING_START";
          // мгновенная подсветка: patch членов + immediate-wake
          ctx.cards.patch("voice", voiceFields(), { immediate: true });
          return;
        }
        case "VOICE_STATE_CREATE":
        case "VOICE_STATE_UPDATE":
          upsertVoiceState(d);
          publish();
          return;
        case "VOICE_STATE_DELETE": {
          const id = d.user && d.user.id ? String(d.user.id) : "";
          delete members[id];
          order = order.filter(x => x !== id);
          publish();
          return;
        }
      }
    }

    function upsertVoiceState(vs) {
      if (!vs || !vs.user || !vs.user.id) return;
      const id = String(vs.user.id);
      const name = (vs.nick && String(vs.nick)) ||
                   (vs.user.global_name && String(vs.user.global_name)) ||
                   (vs.user.username && String(vs.user.username)) || id;
      const hash = vs.user.avatar ? String(vs.user.avatar) : null;
      if (!members[id]) { members[id] = { speaking: false, iconKey: null }; order.push(id); }
      members[id].name = name;
      members[id].hash = hash;
      queueAvatar(id, hash, defaultAvatarIndex(vs.user));
    }

    function cleanupCall() {
      channelId = null;
      channelName = "";
      order = [];
      for (const k of Object.keys(members)) delete members[k];
    }

    // ---- карточка ----

    function voiceFields() {
      const others = order.filter(id => id !== selfId);
      const shown = others.slice(0, 4).map(id => {
        const m = members[id];
        return { iconId: m.iconKey || "", mono: m.name, speaking: !!m.speaking };
      });
      const f = {
        label: ctx.settings.get("showChannelName") !== false ? channelName : "",
        members: shown,
        overflow: Math.max(0, others.length - shown.length),
      };
      const me = selfId ? members[selfId] : null;
      if (me) f.self = { iconId: me.iconKey || "", mono: me.name, speaking: !!me.speaking };
      return f;
    }

    function publish() {
      if (!channelId || order.length === 0) {
        ctx.cards.remove("voice");
        declareContext();
        return;
      }
      const payload = Object.assign({ type: "voice" }, voiceFields());
      ctx.cards.upsert("voice", payload, { stalenessSec: STALE_SEC });
    }

    function declareContext() {
      ctx.context.declare("voice", {
        active: !!channelId,
        scene: false,
        recipe: [{ cardId: "voice", band: 2, order: 1.5 }],
      });
    }

    // ---- аватарки: cdn → toIcon (хост-пул) → cards.icon; кэш по id/hash ----

    function defaultAvatarIndex(user) {
      const d = Number(user.discriminator || 0);
      if (d) return d % 5;
      const id = Number(String(user.id || "0").slice(0, 12));
      return Math.abs(Math.floor(id / 4194304)) % 6;
    }

    function queueAvatar(userId, hash, defIdx) {
      const key = userId + "/" + (hash || "default");
      if (avatars[key]) {
        if (typeof avatars[key] === "string" && avatars[key] !== "pending" && avatars[key] !== "fail")
          members[userId].iconKey = avatars[key];
        return;
      }
      avatars[key] = "pending";
      const url = hash
        ? "https://cdn.discordapp.com/avatars/" + userId + "/" + hash + ".png?size=32"
        : "https://cdn.discordapp.com/embed/avatars/" + defIdx + ".png";
      ctx.images.toIcon(url, 24)
        .then(icon => {
          const iconKey = "u" + userId;
          if (!ctx.cards.icon(iconKey, icon)) { avatars[key] = "fail"; return; }
          avatars[key] = iconKey;
          if (members[userId]) { members[userId].iconKey = iconKey; publish(); }
        })
        .catch(e => { avatars[key] = "fail"; ctx.log.warn("аватар " + userId + ": " + e); });
    }

    // keepalive: карточка не должна протухать в тихом войсе (staleness 20 с)
    ctx.timers.setInterval(() => { if (channelId) publish(); }, KEEPALIVE_MS);

    ctx.settings.onChange(() => {
      generation++;
      if (pipe) { try { pipe.close(); } catch { } pipe = null; }
      cleanupCall();
      publish();
      connect(0);
    });

    connect(0);
  },

  deactivate() {
    // пайпы/таймеры принудительно закрывает хост
  },
});
