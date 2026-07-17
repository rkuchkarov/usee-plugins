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
// ---- SHA-256 (чистый JS — для PKCE S256; в песочнице нет WebCrypto) ----

function sha256(ascii) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bytes = [];
  for (let i = 0; i < ascii.length; i++) bytes.push(ascii.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++)
      w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) |
             (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = [];
  for (const x of [h0, h1, h2, h3, h4, h5, h6, h7])
    out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  return out;
}

function base64Url(bytes) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += abc[b0 >> 2] + abc[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) s += abc[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) s += abc[b2 & 63];
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

    ctx.cards.declare([{
      id: "voice", label: "Discord — голосовой канал", type: "voice",
      fields: {
        "members.count":         { label: "Участники", kind: "number" },
        "members.any(speaking)": { label: "Кто-то говорит", kind: "bool",
                                   ha: { device_class: "sound" } },
        "_present":              { label: "В голосовом канале", kind: "bool",
                                   ha: { device_class: "connectivity" } },
      },
    }]);

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
        ctx.status.set("warn", "переподключение…");
        cleanupCall();
        publish();
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
      // PKCE S256 — ровно как нативный путь: code_challenge = b64url(sha256(verifier)),
      // обмен кода без client_secret (публичный клиент).
      let verifier = "";
      for (let i = 0; i < 64; i++) verifier += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)];
      send("AUTHORIZE", {
        client_id: CLIENT_ID, scopes: SCOPES,
        code_challenge: base64Url(sha256(verifier)),
        code_challenge_method: "S256",
      }, null, (err, data) => {
        if (err || !data || !data.code) {
          ctx.status.set("error", "авторизация отклонена: " + (err || "нет кода"));
          return;
        }
        exchangeCode(data.code, verifier);
      });
    }

    function exchangeCode(code, verifier) {
      const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier };
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
      publish();
      ctx.log.info("в канале " + (channelName || id) + ": " + order.length);
    }

    function dispatchEvent(evt, d) {
      switch (evt) {
        case "VOICE_CHANNEL_SELECT":
          if (d.channel_id) send("GET_SELECTED_VOICE_CHANNEL", {}, null, (err, data) => { if (!err) enterChannel(data); });
          else { cleanupCall(); publish(); }
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
        return;
      }
      const payload = Object.assign({ type: "voice" }, voiceFields());
      ctx.cards.upsert("voice", payload, { stalenessSec: STALE_SEC });
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
