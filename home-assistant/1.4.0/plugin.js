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

// ---- хелперы, общие для activate и providers (SDK v1.1) ----

function urlsOf(ctx) {
  let u = String(ctx.settings.get("url") || "").trim().replace(/\/+$/, "");
  if (!u) return null;
  if (u.startsWith("ws://") || u.startsWith("wss://")) {
    const http = "http" + u.slice(2).replace(/\/api\/websocket$/i, "");
    return { ws: u.match(/\/api\/websocket$/i) ? u : u + "/api/websocket", http };
  }
  if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
  return { ws: "ws" + u.slice(4) + "/api/websocket", http: u };
}

function accessTokenOf(ctx) {
  const longLived = String(ctx.settings.get("token") || "").trim();
  if (longLived) return Promise.resolve(longLived);
  const refresh = String(ctx.settings.get("auth") || "").trim();
  const u = urlsOf(ctx);
  if (!refresh || !u) return Promise.resolve(null);
  const form = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refresh) +
               "&client_id=" + encodeURIComponent(OAUTH_CLIENT_ID);
  return ctx.net.fetch(u.http + "/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }).then(r => {
    if (!r.ok) {
      ctx.log.warn("обмен refresh-токена: HTTP " + r.status + " " + String(r.text).slice(0, 160));
      return null;
    }
    const j = r.json();
    return j && j.access_token ? String(j.access_token) : null;
  }).catch(e => { ctx.log.warn("обмен refresh-токена: " + e); return null; });
}

// Короткая WS-сессия для providers: auth → get_states → close. Резолвится
// массивом сырых состояний HA (то, что раньше делал хостовый HaEntities.Fetch).
function fetchStatesShort(ctx) {
  return accessTokenOf(ctx).then(access => new Promise((resolve, reject) => {
    if (!access) { reject("нет доступа: войдите или вставьте токен"); return; }
    const u = urlsOf(ctx);
    if (!u) { reject("заполните адрес сервера"); return; }
    let sock;
    try { sock = ctx.net.ws(u.ws); }
    catch (e) { reject(String(e)); return; }
    let done = false;
    let cmdId = 0;
    const timer = ctx.timers.setTimeout(() => finish(null, "таймаут подключения"), 4500);
    function finish(states, err) {
      if (done) return;
      done = true;
      ctx.timers.clear(timer);
      try { sock.close(); } catch { }
      if (states) resolve(states); else reject(err || "ошибка");
    }
    sock.on("message", text => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === "auth_required") sock.send(JSON.stringify({ type: "auth", access_token: access }));
      else if (msg.type === "auth_invalid") finish(null, "токен отклонён");
      else if (msg.type === "auth_ok") sock.send(JSON.stringify({ id: ++cmdId, type: "get_states" }));
      else if (msg.type === "result") finish(Array.isArray(msg.result) ? msg.result : []);
    });
    sock.on("error", e => finish(null, String(e)));
    sock.on("close", why => finish(null, String(why)));
  }));
}

definePlugin({
  // Вызываемые экспорты (SDK v1.1): опции пикеров поставляет сам плагин —
  // хостовый UI остаётся генериком. Работают от значений ФОРМЫ (хост на время
  // вызова подменяет settings), т.е. и до первого сохранения настроек.
  providers: {
    listEntities(ctx) {
      return fetchStatesShort(ctx).then(states => states
        .filter(st => st && st.entity_id)
        .map(st => {
          const a = st.attributes || {};
          const unit = a.unit_of_measurement ? String(a.unit_of_measurement) : undefined;
          const s = String(st.state ?? "");
          const detail = s && s !== "unavailable" && s !== "unknown"
            ? s + (unit ? " " + unit : "") : undefined;
          return {
            id: String(st.entity_id),
            label: a.friendly_name ? String(a.friendly_name) : String(st.entity_id),
            detail, unit,
          };
        }));
    },
    checkConnection(ctx) {
      return fetchStatesShort(ctx)
        .then(s => ({ ok: true, text: "подключено · " + s.length + " сущностей" }))
        .catch(e => ({ ok: false, text: String(e) }));
    },
  },

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
        }))
        .filter(b => b.entities.length > 0);
    }

    function numOrNull(v) {
      const n = Number(v);
      return typeof v === "number" || (typeof v === "string" && v !== "" && isFinite(n)) ? n : null;
    }

    // Сущности, чьи состояния нужны: сущности активных биндингов. Условия
    // видимости теперь общие (движок ядра на карточке plug:home-assistant:<id>),
    // здесь их нет.
    function wanted() {
      const set = {};
      for (const b of bindings()) {
        if (!b.enabled) continue;
        for (const e of b.entities) set[e.toLowerCase()] = true;
      }
      return Object.keys(set);
    }

    function urls() { return urlsOf(ctx); }
    function accessToken() { return accessTokenOf(ctx); }

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
            if (!declaredWithStates) {           // friendly-имена подтянулись
              declaredWithStates = true;
              declareCatalog();
            }
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
        deviceClass: attrs.device_class ? String(attrs.device_class) : null,
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
        states[id] = { state: "unavailable", friendly: states[id].friendly, unit: states[id].unit, deviceClass: states[id].deviceClass };
      publish();   // карточки покажут «—»; без реконнекта их скроет staleness
    }

    // ---- карточки ----

    function publish() {
      // затянувшийся blip деградирует в unavailable
      const t = now();
      for (const id of Object.keys(badSince))
        if (t - badSince[id] > BLIP_HOLD_MS && states[id]) {
          states[id] = { state: "unavailable", friendly: states[id].friendly, unit: states[id].unit, deviceClass: states[id].deviceClass };
          delete badSince[id];
        }

      const bs = bindings();
      const ids = cardIds(bs);
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const cardId = ids[i];
        if (!b.enabled) { ctx.cards.remove(cardId); continue; }
        const anyKnown = b.entities.some(e => states[e.toLowerCase()]);
        if (!anyKnown) { ctx.cards.remove(cardId); continue; }

        const kind = autoKind(b, states[b.entities[0].toLowerCase()]);
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

    // Стабильный id карточки = первая сущность (а не индекс биндинга): ключ
    // plug:home-assistant:<entity> переживает перестановку биндингов, поэтому
    // раскладки сцен/пины/тюнинг, где он записан, не слетают. Дубль сущности
    // в нескольких биндингах получает суффикс #2, #3…
    function cardIds(bs) {
      const used = {};
      return bs.map(b => {
        let id = b.entities[0].toLowerCase();
        if (used[id]) id += "#" + (++used[id]);
        else used[id] = 1;
        return id;
      });
    }

    // Каталог карточек (SDK v1.1): полный список с подписями — раскладки сцен
    // видят карточку и без данных. Повторный declare заменяет каталог целиком.
    // Метка is_on по device_class (где различимо) — иначе «Вкл».
    function boolLabel(dc) {
      switch (dc) {
        case "door": return "Открыто";
        case "window": return "Окно открыто";
        case "garage_door": return "Гараж открыт";
        case "motion": case "occupancy": return "Движение";
        case "lock": return "Заперто";
        case "moisture": return "Протечка";
        case "smoke": return "Дым";
        case "presence": return "Дома";
        default: return "Вкл";
      }
    }

    // Декларации полей шины для карточки: state всегда; для булевых доменов —
    // is_on (+ha device_class), иначе — number (+ha unit/device_class/state_class).
    function declaredFields(b, st) {
      const id = b.entities[0];
      const f = { "state": { label: "Состояние", kind: "string" } };
      if (isBoolDomain(id)) {
        const dc = (st && st.deviceClass) || "running";
        f["is_on"] = { label: boolLabel(st && st.deviceClass), kind: "bool", ha: { device_class: dc } };
      } else {
        const ha = {};
        if (st && st.unit) ha.unit = st.unit;
        if (st && st.deviceClass) ha.device_class = st.deviceClass;
        ha.state_class = "measurement";
        f["number"] = { label: "Значение", kind: "number", ha };
      }
      return f;
    }

    let declaredWithStates = false;
    function declareCatalog() {
      const bs = bindings();
      const ids = cardIds(bs);
      const list = [];
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if (!b.enabled) continue;   // чекбокс в списке = присутствие в каталоге
        const st = states[b.entities[0].toLowerCase()];
        const kind = autoKind(b, states[b.entities[0].toLowerCase()]);
        list.push({
          id: ids[i],
          label: b.label || (st && st.friendly) || b.entities[0],
          type: kind,
          fields: declaredFields(b, st),
        });
      }
      ctx.cards.declare(list);
    }

    function stateOf(entity) { return states[entity.toLowerCase()] || null; }

    // ---- контракт значений шины: сырьё .state + честные .number/.is_on ----
    // Никакой коэрции: number публикуется ТОЛЬКО когда состояние честно
    // числовое; is_on — только для булевых доменов по таблице; текстовый сенсор
    // отдаёт лишь .state. Никаких «?? 0».
    function entityDomain(id) { const d = id.indexOf("."); return d > 0 ? id.slice(0, d).toLowerCase() : ""; }

    // домен → множество «включённых» состояний (остальные известные → false)
    const BOOL_ON = {
      binary_sensor: ["on"], switch: ["on"], input_boolean: ["on"], light: ["on"],
      fan: ["on"], automation: ["on"], script: ["on"], remote: ["on"], siren: ["on"],
      humidifier: ["on"], media_player: ["playing", "on"],
      lock: ["locked"], cover: ["open"], garage: ["open"],
      person: ["home"], device_tracker: ["home"], sun: ["above_horizon"],
    };
    function isBoolDomain(id) { return !!BOOL_ON[entityDomain(id)]; }
    function boolOf(id, state) {
      const on = BOOL_ON[entityDomain(id)];
      return on ? on.indexOf(String(state).trim().toLowerCase()) >= 0 : null;
    }
    // всё состояние целиком — число (не «3 lights», не «running»)
    function honestNumber(state) {
      const s = String(state).trim();
      if (s === "") return null;
      const n = Number(s);
      return isFinite(n) ? n : null;
    }
    function rawState(st) { return st && st.state != null ? String(st.state) : ""; }

    // Авто-тип карточки: числовое состояние → gauge (несёт .number), булевое или
    // текстовое → status (несёт .state/.is_on, но НЕ авто-.number). Так карточка
    // не рекламирует .number, которого у неё нет.
    function autoKind(b, st) {
      if (b.card !== "auto") return b.card;
      if (b.entities.length >= 2) return "meters";
      const id = b.entities[0];
      if (isBoolDomain(id)) return "status";
      if (st && honestNumber(st.state) !== null) return "gauge";
      return "status";
    }

    // Поля значения по ПЕРВОЙ сущности биндинга: state всегда; число/булево —
    // только честно (и только при доступном состоянии).
    function valueFields(b) {
      const id = b.entities[0];
      const st = stateOf(id);
      const out = { state: rawState(st) };
      if (!st || isUnavailable(st.state)) return out;
      if (isBoolDomain(id)) {
        const on = boolOf(id, st.state);
        if (on !== null) out.is_on = on;
      } else {
        const n = honestNumber(st.state);
        if (n !== null) out.number = n;   // float как есть; округляет устройство
      }
      return out;
    }

    function buildGauge(b) {
      const st = stateOf(b.entities[0]);
      const label = (b.label || (st && st.friendly) || b.entities[0]).toUpperCase();
      const vf = valueFields(b);
      const p = Object.assign({ type: "gauge", label }, vf);
      if (vf.number != null) {
        p.unit = b.unit || (st && st.unit) || "";
        if (b.min != null && b.max != null && b.max > b.min) { p.min = b.min; p.max = b.max; }
      }
      return p;   // без number gauge рисует «—» (unit ставит хост)
    }

    function buildMeters(b) {
      const rows = b.entities.slice(0, 4).map(e => {
        const st = stateOf(e);
        const n = st && !isUnavailable(st.state) ? honestNumber(st.state) : null;
        return {
          label: ((st && st.friendly) || lastSegment(e)).toUpperCase(),
          pct: n === null ? 0 : Math.max(0, Math.min(100, Math.round(n))),
        };
      });
      return Object.assign({ type: "meters", title: b.title || "", rows }, valueFields(b));
    }

    function buildStatus(b) {
      const st = stateOf(b.entities[0]);
      const line1 = (b.label || (st && st.friendly) || b.entities[0]).toUpperCase();
      const vf = valueFields(b);
      if (!st || isUnavailable(st.state))
        return Object.assign({ type: "status", line1, badge: DASH, badgeKind: "plain" }, vf);
      const on = isOn(st.state);
      const badge = (b.badgeOn !== null || b.badgeOff !== null)
        ? String(on ? (b.badgeOn ?? "") : (b.badgeOff ?? ""))
        : st.state.toUpperCase();
      return Object.assign({ type: "status", line1, badge, badgeKind: on ? "accent" : "plain" }, vf);
    }

    // ---- helpers ----

    function isUnavailable(s) {
      return !s || s.toLowerCase() === "unavailable" || s.toLowerCase() === "unknown";
    }
    function isOn(s) { return ON_STATES.indexOf(String(s).trim().toLowerCase()) >= 0; }
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
      declaredWithStates = false;
      declareCatalog();
      generation++;
      const s = sock; sock = null;
      if (s) { try { s.close(); } catch { } }
      backoff = RECONNECT_MIN;
      if (reconnectTimer !== -1) { ctx.timers.clear(reconnectTimer); reconnectTimer = -1; }
      connect();
    });

    declareCatalog();
    connect();
  },

  deactivate() {
    // сокеты и таймеры принудительно закрывает хост
  },
});
