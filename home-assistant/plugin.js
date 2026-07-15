// Home Assistant для Usee — плагин с паритетом встроенного HASource:
// WebSocket-подписка на состояния сущностей, карточки gauge/meters/status по
// биндингам, тосты из событий usee_notify, «—» при недоступности с 20-секундным
// удержанием последнего значения, heartbeat + реконнект с бэкоффом.
//
// Авторизация: long-lived токен (настройка token) ИЛИ refresh-токен, положенный
// oauth-полем «Вход через браузер» (настройка auth). Refresh обменивается на
// короткий access через POST /auth/token; client_id обязан совпадать с тем, с
// которым хост проводил вход (loopback-адрес хост-хелпера).
const OAUTH_CLIENT_ID = "http://localhost:8127/";

const DASH = "—";
const BLIP_HOLD_MS = 20000;   // «unavailable» короче этого держит последнее значение
const PING_MS = 10000;        // heartbeat (HA молчит на тихой подписке)
const RX_TIMEOUT_MS = 20000;  // нет входящих дольше — связь мертва → реконнект
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;
const STALE_SEC = 30;         // карточка без обновлений уходит с панели

const ON_STATES = ["on", "true", "open", "home", "yes", "1", "detected", "active", "playing", "heat", "cool"];

definePlugin({
  activate(ctx) {
    const states = {};      // entity_id → {state, friendly, unit}
    const badSince = {};    // entity_id → ts первого «unavailable» (blip-hold)
    let sock = null;
    let stopped = false;
    let cmdId = 0;
    let lastRx = 0;
    let backoff = RECONNECT_MIN;
    let reconnectTimer = -1;
    let generation = 0;     // инвалидация колбеков старых сокетов

    // ---- настройки ----

    function bindings() {
      const raw = ctx.settings.get("bindings");
      const list = Array.isArray(raw) ? raw : [];
      return list
        .map(b => ({
          entities: String(b.entities || "").split(",").map(s => s.trim()).filter(s => s),
          card: b.card || "auto",
          label: b.label || null, unit: b.unit || null,
          min: numOrNull(b.min), max: numOrNull(b.max),
          title: b.title || null, badgeOn: b.badgeOn ?? null, badgeOff: b.badgeOff ?? null,
          band: numOrNull(b.band) ?? 4, order: numOrNull(b.order) ?? 1,
          width: b.width === "flex" || b.width === "fixed" ? b.width : null,
          minW: numOrNull(b.minW), maxW: numOrNull(b.maxW),
          enabled: b.enabled !== false,
          cond: condOf(b),
        }))
        .filter(b => b.entities.length > 0);
    }

    function numOrNull(v) {
      const n = Number(v);
      return typeof v === "number" || (typeof v === "string" && v !== "" && isFinite(n)) ? n : null;
    }

    function condOf(b) {
      const op = String(b.condOp || "");
      if (!b.condEntity || !op || op === "нет") return null;
      return { entity: String(b.condEntity).trim(), op, value: String(b.condValue ?? "") };
    }

    // Сущности, чьи состояния нужны: биндинги + сущности условий.
    function wanted() {
      const set = {};
      for (const b of bindings()) {
        if (!b.enabled) continue;
        for (const e of b.entities) set[e.toLowerCase()] = true;
        if (b.cond) set[b.cond.entity.toLowerCase()] = true;
      }
      return Object.keys(set);
    }

    function urls() {
      let u = String(ctx.settings.get("url") || "").trim().replace(/\/+$/, "");
      if (!u) return null;
      if (u.startsWith("ws://") || u.startsWith("wss://")) {
        const http = "http" + u.slice(2).replace(/\/api\/websocket$/i, "");
        return { ws: u.match(/\/api\/websocket$/i) ? u : u + "/api/websocket", http };
      }
      if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
      return { ws: "ws" + u.slice(4) + "/api/websocket", http: u };
    }

    // ---- access-токен: token-настройка или refresh → /auth/token ----

    function accessToken() {
      const longLived = String(ctx.settings.get("token") || "").trim();
      if (longLived) return Promise.resolve(longLived);
      const refresh = String(ctx.settings.get("auth") || "").trim();
      const u = urls();
      if (!refresh || !u) return Promise.resolve(null);
      const form = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refresh) +
                   "&client_id=" + encodeURIComponent(OAUTH_CLIENT_ID);
      return ctx.net.fetch(u.http + "/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      }).then(r => {
        if (!r.ok) { ctx.log.warn("обмен refresh-токена: HTTP " + r.status); return null; }
        const j = r.json();
        return j && j.access_token ? String(j.access_token) : null;
      }).catch(e => { ctx.log.warn("обмен refresh-токена: " + e); return null; });
    }

    // ---- соединение ----

    function connect() {
      if (stopped) return;
      const u = urls();
      if (!u) { ctx.status.set("warn", "заполните адрес сервера"); return; }

      accessToken().then(access => {
        if (stopped) return;
        if (!access) {
          ctx.status.set("error", "нет доступа: войдите или вставьте токен");
          scheduleReconnect();
          return;
        }
        const gen = ++generation;
        let s;
        try { s = ctx.net.ws(u.ws); }
        catch (e) { ctx.log.warn("ws: " + e); scheduleReconnect(); return; }
        sock = s;
        lastRx = now();

        s.on("message", text => {
          if (gen !== generation) return;
          lastRx = now();
          let msg;
          try { msg = JSON.parse(text); } catch { return; }
          handle(s, msg, access);
        });
        s.on("close", why => {
          if (gen !== generation) return;
          markDisconnected();
          ctx.log.info("отключено: " + why);
          scheduleReconnect();
        });
        s.on("error", e => { if (gen === generation) ctx.log.warn("ws error: " + e); });
      });
    }

    function handle(s, msg, access) {
      switch (msg.type) {
        case "auth_required":
          s.send(JSON.stringify({ type: "auth", access_token: access }));
          return;
        case "auth_invalid":
          ctx.status.set("error", "токен отклонён");
          s.close();
          return;
        case "auth_ok": {
          const w = wanted();
          if (w.length > 0)
            s.send(JSON.stringify({
              id: ++cmdId, type: "subscribe_trigger",
              trigger: { platform: "state", entity_id: w },
            }));
          s.send(JSON.stringify({ id: ++cmdId, type: "subscribe_events", event_type: "usee_notify" }));
          s.send(JSON.stringify({ id: ++cmdId, type: "get_states" }));
          backoff = RECONNECT_MIN;
          ctx.status.set("ok", "подключено");
          return;
        }
        case "result":
          if (Array.isArray(msg.result)) {
            for (const st of msg.result) storeState(st);
            publish();
          }
          return;
        case "event": {
          const ev = msg.event || {};
          if (ev.event_type === "usee_notify") {
            const d = ev.data || {};
            ctx.toast(String(d.kind || "notice"), String(d.title || ""),
                      String(d.message || ""), numOrNull(d.ttlMs) ?? undefined);
            return;
          }
          const to = ev.variables && ev.variables.trigger && ev.variables.trigger.to_state;
          if (to) { storeState(to); publish(); }
          return;
        }
      }
    }

    function storeState(st) {
      if (!st || !st.entity_id) return;
      const id = String(st.entity_id).toLowerCase();
      const attrs = st.attributes || {};
      const incoming = {
        state: String(st.state ?? ""),
        friendly: attrs.friendly_name ? String(attrs.friendly_name) : null,
        unit: attrs.unit_of_measurement ? String(attrs.unit_of_measurement) : null,
      };
      const prev = states[id];
      if (isUnavailable(incoming.state) && prev && !isUnavailable(prev.state)) {
        // кратковременный provал: держим последнее значение BLIP_HOLD_MS
        if (!(id in badSince)) badSince[id] = now();
        return;
      }
      if (!isUnavailable(incoming.state)) delete badSince[id];
      states[id] = incoming;
    }

    function markDisconnected() {
      for (const id of Object.keys(states))
        states[id] = { state: "unavailable", friendly: states[id].friendly, unit: states[id].unit };
      publish();   // карточки покажут «—»; без реконнекта их скроет staleness
    }

    // ---- карточки ----

    function publish() {
      // затянувшийся blip деградирует в unavailable
      const t = now();
      for (const id of Object.keys(badSince))
        if (t - badSince[id] > BLIP_HOLD_MS && states[id]) {
          states[id] = { state: "unavailable", friendly: states[id].friendly, unit: states[id].unit };
          delete badSince[id];
        }

      const bs = bindings();
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const cardId = "b" + i + ":" + b.entities[0].toLowerCase();
        if (!b.enabled || (b.cond && !condMet(b.cond))) { ctx.cards.remove(cardId); continue; }
        const anyKnown = b.entities.some(e => states[e.toLowerCase()]);
        if (!anyKnown) { ctx.cards.remove(cardId); continue; }

        const kind = b.card === "auto" ? (b.entities.length >= 2 ? "meters" : "gauge") : b.card;
        const opts = {
          band: clampInt(b.band, 1, 6), order: b.order, stalenessSec: STALE_SEC,
        };
        if (b.width) opts.width = b.width;
        if (b.minW != null) opts.minW = clampInt(b.minW, 2, 6);
        if (b.maxW != null) opts.maxW = clampInt(b.maxW, 2, 6);

        if (kind === "meters") ctx.cards.upsert(cardId, buildMeters(b), opts);
        else if (kind === "status") ctx.cards.upsert(cardId, buildStatus(b), opts);
        else ctx.cards.upsert(cardId, buildGauge(b), opts);
      }
    }

    function stateOf(entity) { return states[entity.toLowerCase()] || null; }

    function buildGauge(b) {
      const st = stateOf(b.entities[0]);
      const label = (b.label || (st && st.friendly) || b.entities[0]).toUpperCase();
      const v = st && !isUnavailable(st.state) ? parseNum(st.state) : null;
      if (v === null)
        return { type: "gauge", label, value: 0, unit: DASH };
      const p = { type: "gauge", label, value: Math.round(v), unit: b.unit || (st && st.unit) || "" };
      if (b.min != null && b.max != null && b.max > b.min) { p.min = b.min; p.max = b.max; p.value = v; }
      return p;
    }

    function buildMeters(b) {
      const rows = b.entities.slice(0, 4).map(e => {
        const st = stateOf(e);
        const v = st && !isUnavailable(st.state) ? parseNum(st.state) : null;
        return {
          label: ((st && st.friendly) || lastSegment(e)).toUpperCase(),
          pct: v === null ? 0 : Math.max(0, Math.min(100, Math.round(v))),
        };
      });
      return { type: "meters", title: b.title || "", rows };
    }

    function buildStatus(b) {
      const st = stateOf(b.entities[0]);
      const line1 = (b.label || (st && st.friendly) || b.entities[0]).toUpperCase();
      if (!st || isUnavailable(st.state))
        return { type: "status", line1, badge: DASH, badgeKind: "plain" };
      const on = isOn(st.state);
      const badge = (b.badgeOn !== null || b.badgeOff !== null)
        ? String(on ? (b.badgeOn ?? "") : (b.badgeOff ?? ""))
        : st.state.toUpperCase();
      return { type: "status", line1, badge, badgeKind: on ? "accent" : "plain" };
    }

    // ---- условия видимости (паритет HaBindings.CondMet) ----

    function condMet(c) {
      const st = stateOf(c.entity);
      const state = st ? st.state : "";
      const avail = !!st && !isUnavailable(state);
      switch (c.op) {
        case "exists": return avail;
        case "not_exists": return !avail;
        case "is_on": return avail && isOn(state);
        case "is_off": return avail && !isOn(state);
      }
      const val = c.value || "";
      const eq = (a, b2) => a.trim().toLowerCase() === b2.trim().toLowerCase();
      switch (c.op) {
        case "==": return eq(state, val);
        case "!=": return !eq(state, val);
        case "contains": return state.toLowerCase().includes(val.toLowerCase());
        case "not_contains": return !state.toLowerCase().includes(val.toLowerCase());
        case "startswith": return state.toLowerCase().startsWith(val.toLowerCase());
        case "endswith": return state.toLowerCase().endsWith(val.toLowerCase());
        case "in": case "not_in": {
          const inList = val.split(",").map(s => s.trim()).filter(s => s).some(p => eq(state, p));
          return c.op === "in" ? inList : !inList;
        }
        case "<": case ">": case "<=": case ">=": {
          const a = parseNum(state), b2 = parseNum(val);
          if (a === null || b2 === null) return false;
          return c.op === "<" ? a < b2 : c.op === ">" ? a > b2 : c.op === "<=" ? a <= b2 : a >= b2;
        }
        default: return true;    // неизвестный оператор → не прятать
      }
    }

    // ---- helpers ----

    function isUnavailable(s) {
      return !s || s.toLowerCase() === "unavailable" || s.toLowerCase() === "unknown";
    }
    function isOn(s) { return ON_STATES.indexOf(String(s).trim().toLowerCase()) >= 0; }
    function parseNum(s) {
      const m = String(s).trim().match(/^[-+]?[0-9]*\.?[0-9]+/);
      return m ? Number(m[0]) : null;
    }
    function lastSegment(e) {
      const dot = e.lastIndexOf(".");
      return dot >= 0 ? e.slice(dot + 1) : e;
    }
    function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }
    function now() { return Date.now(); }

    function scheduleReconnect() {
      if (stopped || reconnectTimer !== -1) return;
      reconnectTimer = ctx.timers.setTimeout(() => {
        reconnectTimer = -1;
        connect();
      }, backoff);
      backoff = Math.min(RECONNECT_MAX, backoff * 2);
    }

    // heartbeat + rx-watchdog: HA молчит на тихой подписке — пингуем; молчание
    // дольше RX_TIMEOUT_MS означает мёртвую связь → принудительный реконнект.
    ctx.timers.setInterval(() => {
      if (stopped || !sock) return;
      try { sock.send(JSON.stringify({ id: ++cmdId, type: "ping" })); } catch { }
      if (now() - lastRx > RX_TIMEOUT_MS) {
        ctx.log.warn("rx-таймаут — переподключение");
        const s = sock; sock = null;
        generation++;         // колбеки старого сокета больше не считаются
        try { s.close(); } catch { }
        markDisconnected();
        scheduleReconnect();
      }
    }, PING_MS);

    // смена настроек → мгновенный полный reconnect (адрес/токен/подписки)
    ctx.settings.onChange(() => {
      ctx.log.info("настройки изменились — переподключение");
      generation++;
      const s = sock; sock = null;
      if (s) { try { s.close(); } catch { } }
      backoff = RECONNECT_MIN;
      if (reconnectTimer !== -1) { ctx.timers.clear(reconnectTimer); reconnectTimer = -1; }
      connect();
    });

    connect();
  },

  deactivate() {
    // сокеты и таймеры принудительно закрывает хост
  },
});
