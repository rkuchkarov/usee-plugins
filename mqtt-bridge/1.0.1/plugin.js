// MQTT-мост Usee → Home Assistant: экспортирует выбранные в дереве «Источники»
// поля шины значений как MQTT Discovery-сущности одного устройства «Usee».
// КЛЮЧЕВОЙ ИНВАРИАНТ: в этом файле НЕТ ни одного имени чужой карточки — маппинг
// целиком генерик: выбранные источники → каталог шины → discovery из kind и
// ha-метаданных владельца поля. object_id детерминированно из адреса
// (snake_case); коллизия → лог и пропуск; поле без ha-меты → generic sensor.
const KEEPALIVE_SEC = 30;
const RECONCILE_SEC = 30;       // страховочный поллинг каталога (основной триггер — cards-канал)

// ---- мини-MQTT 3.1.1 поверх ctx.net.tcp (копия шаблонного mqtt.ts) ----

function utf8(s) {
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
function utf8decode(a) {
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
function str16(s) {
  const b = utf8(s);
  return [b.length >> 8, b.length & 255, ...b];
}
function varint(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0);
  return out;
}
function frame(type, body) {
  return Uint8Array.from([type, ...varint(body.length), ...body]);
}

function mqttConnect(ctx, o, h) {
  let sock = null, alive = false, closed = false, backoff = 2000;
  let pingTimer = -1, packetId = 0, rxBuf = new Uint8Array(0);

  function connectPacket() {
    let flags = 0x02;
    const body = [0, 4, 77, 81, 84, 84, 4];
    if (o.will) flags |= 0x04 | (o.will.retain ? 0x20 : 0);
    if (o.username) flags |= 0x80;
    if (o.password) flags |= 0x40;
    body.push(flags, KEEPALIVE_SEC >> 8, KEEPALIVE_SEC & 255);
    body.push(...str16(o.clientId));
    if (o.will) { body.push(...str16(o.will.topic)); body.push(...str16(o.will.payload)); }
    if (o.username) body.push(...str16(o.username));
    if (o.password) body.push(...str16(o.password));
    return frame(0x10, body);
  }

  function open() {
    if (closed) return;
    ctx.log.info("mqtt: подключаюсь к " + o.host + ":" + o.port + (o.tls ? " (tls)" : ""));
    let s;
    try { s = ctx.net.tcp(o.host, o.port, { tls: !!o.tls }); }
    catch (e) { scheduleReconnect("connect: " + e); return; }
    sock = s;
    rxBuf = new Uint8Array(0);
    s.on("data", chunk => onData(chunk));
    s.on("close", why => {
      alive = false;
      if (pingTimer !== -1) { ctx.timers.clear(pingTimer); pingTimer = -1; }
      if (h.onClose) h.onClose(why);
      scheduleReconnect(why);
    });
    s.write(connectPacket());
  }

  function scheduleReconnect(why) {
    if (closed) return;
    ctx.log.info("mqtt: реконнект через " + backoff + " мс (" + why + ")");
    ctx.timers.setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 60000);
  }

  function onData(chunk) {
    const next = new Uint8Array(rxBuf.length + chunk.length);
    next.set(rxBuf, 0); next.set(chunk, rxBuf.length);
    rxBuf = next;
    for (;;) {
      if (rxBuf.length < 2) return;
      let len = 0, mult = 1, i = 1;
      for (;;) {
        if (i >= rxBuf.length) return;
        const d = rxBuf[i++];
        len += (d & 127) * mult;
        if ((d & 128) === 0) break;
        mult *= 128;
      }
      if (rxBuf.length < i + len) return;
      const type = rxBuf[0] >> 4, flags = rxBuf[0] & 15;
      const body = rxBuf.subarray(i, i + len);
      rxBuf = rxBuf.slice(i + len);
      onPacket(type, flags, body);
    }
  }

  function onPacket(type, flags, body) {
    if (type === 2) {
      if (body[1] !== 0) { ctx.log.error("mqtt: CONNACK rc=" + body[1]); sock.close(); return; }
      alive = true;
      backoff = 2000;
      pingTimer = ctx.timers.setInterval(() => { if (alive) sock.write(Uint8Array.from([0xc0, 0])); },
                                         KEEPALIVE_SEC * 1000);
      if (h.onConnect) h.onConnect();
      return;
    }
    if (type === 3) {
      const qos = (flags >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      const topic = utf8decode(body.subarray(2, 2 + tlen));
      let at = 2 + tlen;
      if (qos > 0) {
        const pid = (body[at] << 8) | body[at + 1];
        at += 2;
        sock.write(frame(0x40, [pid >> 8, pid & 255]));
      }
      if (h.onMessage) h.onMessage(topic, utf8decode(body.subarray(at)));
    }
  }

  open();

  return {
    publish(topic, payload, opts) {
      if (!alive) return;
      const qos = (opts && opts.qos) || 0;
      const body = [...str16(topic)];
      if (qos > 0) {
        packetId = (packetId % 65535) + 1;
        body.push(packetId >> 8, packetId & 255);
      }
      body.push(...utf8(payload));
      sock.write(frame(0x30 | (qos << 1) | (opts && opts.retain ? 1 : 0), body));
    },
    subscribe(filter) {
      if (!alive) return;
      packetId = (packetId % 65535) + 1;
      sock.write(frame(0x82, [packetId >> 8, packetId & 255, ...str16(filter), 0]));
    },
    connected: () => alive,
    close() {
      closed = true;
      if (pingTimer !== -1) ctx.timers.clear(pingTimer);
      try { if (alive) sock.write(Uint8Array.from([0xe0, 0])); } catch { }
      try { if (sock) sock.close(); } catch { }
    },
  };
}

// ---- сам мост ----

// модульный скоуп: deactivate() должен дотянуться до соединения и опубликованных
// сущностей для best-effort очистки («Очистить сущности при выключении»)
let g_ctx = null;
let g_mqtt = null;
let g_published = {};
let g_mid = "";

definePlugin({
  activate(ctx) {
    g_ctx = ctx;
    // стабильный client id устройства
    let mid = ctx.storage.get("machineId");
    if (!mid) {
      mid = "";
      for (let i = 0; i < 12; i++) mid += "0123456789abcdef"[Math.floor(Math.random() * 16)];
      ctx.storage.set("machineId", mid);
    }
    g_mid = mid;
    const availTopic = "usee/" + mid + "/availability";

    let mqtt = null;
    // object_id → address: всё, о чём знает HA. ПЕРСИСТЕНТНО (storage) — иначе
    // снятая галка/рестарт агента потеряли бы, кому слать пустой retained.
    const published = g_published = (ctx.storage.get("published") || {});
    const lastSent = {};           // object_id → тик последней публикации значения
    const throttled = {};          // object_id → таймер trailing-публикации
    const lastValue = {};          // address → последний TypedValue
    const entityAvail = {};        // object_id → "online"|"offline"
    let subscribedAddrs = "";      // подписанные адреса (переподписка при смене)

    function snake(address) {
      return address.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    // поле «достойно экспорта по умолчанию»: несёт ha-мету ИЛИ это основной
    // `.value` карточки. Автозаписи без меты (их порождает схема типа) не
    // раздувают HA — они выбираются в дереве поштучно.
    function hasMeta(ha) {
      return !!(ha && (ha.device_class || ha.unit || ha.state_class || ha.component));
    }
    function defaultExport(e) {
      return hasMeta(e.ha) || e.address === e.cardKey + ".value";
    }

    // выбранные источники → { object_id → каталожная запись }; коллизии
    // object_id пропускаются с внятной ошибкой в лог. Выбор карточки целиком
    // (bare cardKey) = её default-набор (мета + value), НЕ все автополя.
    function desiredEntities() {
      const sources = ctx.settings.get("sources") || [];
      const cat = ctx.data.catalog();
      const byAddress = {};
      for (const e of cat) byAddress[e.address] = e;
      const wanted = [];
      for (const s of sources) {
        if (byAddress[s]) { wanted.push(byAddress[s]); continue; }   // явно выбранное поле
        for (const e of cat) if (e.cardKey === s && defaultExport(e)) wanted.push(e);
      }
      const out = {};
      for (const e of wanted) {
        const obj = snake(e.address);
        if (out[obj] && out[obj].address !== e.address) {
          ctx.log.error("коллизия object_id «" + obj + "»: " + out[obj].address + " и " +
                        e.address + " — вторая сущность пропущена");
          continue;
        }
        out[obj] = e;
      }
      return out;
    }

    function componentOf(e) {
      if (e.ha && e.ha.component) return e.ha.component;
      if (e.kind === "bool") return "binary_sensor";
      if (e.kind === "event") return "event";
      return "sensor";
    }

    function configTopic(e, obj) {
      return "homeassistant/" + componentOf(e) + "/usee_" + mid + "/" + obj + "/config";
    }

    function discoveryConfig(e, obj) {
      const cfg = {
        name: e.label,
        unique_id: "usee_" + mid + "_" + obj,
        state_topic: "usee/" + mid + "/" + obj + "/state",
        availability: [
          { topic: availTopic },
          { topic: "usee/" + mid + "/" + obj + "/availability" },
        ],
        availability_mode: "all",
        device: {
          identifiers: ["usee-" + mid],
          name: String(ctx.settings.get("deviceName") || "Usee"),
          manufacturer: "Usee",
          sw_version: ctx.agent.version,
        },
      };
      const comp = componentOf(e);
      if (e.ha && e.ha.device_class) cfg.device_class = e.ha.device_class;
      if (comp === "sensor") {
        if (e.ha && e.ha.unit) cfg.unit_of_measurement = e.ha.unit;
        if (e.ha && e.ha.state_class) cfg.state_class = e.ha.state_class;
      }
      if (comp === "binary_sensor") { cfg.payload_on = "ON"; cfg.payload_off = "OFF"; }
      if (comp === "event") {
        cfg.event_types = (e.ha && e.ha.event_types) || ["notice", "done", "critical", "achievement"];
        delete cfg.availability;            // событийная сущность живёт от device-availability
        delete cfg.availability_mode;
        cfg.availability = [{ topic: availTopic }];
      }
      return cfg;
    }

    function stateOf(e, v) {
      if (v.state !== "ok") return null;
      if (e.kind === "bool") return v.value ? "ON" : "OFF";
      if (e.kind === "number") return String(Math.round(Number(v.value)));
      return String(v.value);
    }

    // публикация значения с троттлингом minIntervalSec на сущность:
    // bool — немедленно; числа/строки — не чаще интервала, trailing-таймер
    // доносит последнее значение серии
    function publishValue(e, obj, v) {
      lastValue[e.address] = v;
      if (!mqtt || !mqtt.connected()) return;

      const avail = v.state === "ok" ? "online" : "offline";
      if (entityAvail[obj] !== avail) {
        entityAvail[obj] = avail;
        mqtt.publish("usee/" + mid + "/" + obj + "/availability", avail);
      }
      const state = stateOf(e, v);
      if (state === null) return;

      const minMs = Math.max(0, Number(ctx.settings.get("minIntervalSec") || 2) * 1000);
      const now = Date.now();
      const immediate = e.kind === "bool" || e.kind === "event";
      if (immediate || !lastSent[obj] || now - lastSent[obj] >= minMs) {
        lastSent[obj] = now;
        mqtt.publish("usee/" + mid + "/" + obj + "/state", state);
        return;
      }
      if (throttled[obj]) return;                       // trailing уже взведён
      throttled[obj] = ctx.timers.setTimeout(() => {
        delete throttled[obj];
        const cur = lastValue[e.address];
        const st = cur && stateOf(e, cur);
        if (st !== null && mqtt && mqtt.connected()) {
          lastSent[obj] = Date.now();
          mqtt.publish("usee/" + mid + "/" + obj + "/state", st);
        }
      }, Math.max(50, minMs - (now - lastSent[obj])));
    }

    // реконсиляция: желаемое (выбор ∩ каталог) против опубликованного;
    // новым — retained-конфиг + подписка, исчезнувшим — ПУСТОЙ retained
    // (штатное удаление сущности по доке HA)
    function reconcile(forceConfigs) {
      if (!mqtt || !mqtt.connected()) return;
      const desired = desiredEntities();

      for (const obj of Object.keys(published))
        if (!desired[obj]) {
          const e = { address: published[obj], kind: "", ha: null };
          // компонент вычислить нельзя (записи нет в каталоге) — чистим все три
          for (const comp of ["sensor", "binary_sensor", "event"])
            mqtt.publish("homeassistant/" + comp + "/usee_" + mid + "/" + obj + "/config", "", { retain: true, qos: 1 });
          delete published[obj];
          delete entityAvail[obj];
        }

      for (const obj of Object.keys(desired)) {
        const e = desired[obj];
        if (!forceConfigs && published[obj] === e.address) continue;
        mqtt.publish(configTopic(e, obj), JSON.stringify(discoveryConfig(e, obj)), { retain: true, qos: 1 });
        published[obj] = e.address;
        const v = lastValue[e.address];
        if (v) { entityAvail[obj] = null; publishValue(e, obj, v); }
      }
      ctx.storage.set("published", published);

      // подписка шины на актуальный набор адресов (пере-подписка при смене)
      const addrs = Object.values(desired).filter(e => e.kind !== "event").map(e => e.address).sort();
      const sig = addrs.join("|");
      if (sig !== subscribedAddrs && addrs.length > 0) {
        subscribedAddrs = sig;
        const byAddr = {};
        for (const obj of Object.keys(desired)) byAddr[desired[obj].address] = { e: desired[obj], obj };
        ctx.data.values.subscribe(addrs, (address, v) => {
          const hit = byAddr[address];
          if (hit) publishValue(hit.e, hit.obj, v);
        });
      }
      ctx.status.set("ok", "сущностей: " + Object.keys(published).length);
    }

    function publishAllStates() {
      const desired = desiredEntities();
      for (const obj of Object.keys(desired)) {
        const v = lastValue[desired[obj].address];
        if (v) { entityAvail[obj] = null; lastSent[obj] = 0; publishValue(desired[obj], obj, v); }
      }
    }

    function connect() {
      const host = String(ctx.settings.get("host") || "");
      if (host.length === 0) { ctx.status.set("warn", "укажите адрес брокера"); return; }
      ctx.log.info("mqtt: старт, host=" + host + " sources=" + JSON.stringify(ctx.settings.get("sources") || []));
      mqtt = g_mqtt = mqttConnect(ctx, {
        host,
        port: Number(ctx.settings.get("port") || 1883),
        tls: !!ctx.settings.get("tls"),
        clientId: "usee-" + mid,
        username: String(ctx.settings.get("username") || "") || undefined,
        password: String(ctx.settings.get("password") || "") || undefined,
        will: { topic: availTopic, payload: "offline", retain: true },
      }, {
        onConnect() {
          ctx.log.info("mqtt: подключено");
          mqtt.publish(availTopic, "online", { retain: true });
          // Birth-сообщение HA: рестарт Home Assistant → переиздать discovery
          mqtt.subscribe("homeassistant/status");
          reconcile(true);            // force: конфиги заново, ушедшие — пустой retained
          publishAllStates();
        },
        onMessage(topic, payload) {
          if (topic === "homeassistant/status" && payload === "online") {
            ctx.log.info("mqtt: HA перезапустился — переиздаю discovery");
            reconcile(true);
            publishAllStates();
          }
        },
        onClose() { ctx.status.set("warn", "переподключение…"); },
      });
    }

    // тосты → event-сущность немедленно (если выбрана в дереве)
    ctx.data.toasts.subscribe(t => {
      const obj = "toasts";
      if (!published[obj] || !mqtt || !mqtt.connected()) return;
      mqtt.publish("usee/" + mid + "/" + obj + "/state",
                   JSON.stringify({ event_type: t.type, title: t.title, message: t.message }));
    });

    // триггер реконсиляции: появление/исчезновение карточек (установка и
    // удаление плагинов-источников) + страховочный таймер
    ctx.data.cards.subscribe(["*"], () => reconcile());
    ctx.timers.setInterval(reconcile, RECONCILE_SEC * 1000);

    ctx.settings.onChange(() => {
      if (mqtt) mqtt.close();
      subscribedAddrs = "";           // published НЕ трогаем: reconcile сам чистит ушедшее
      connect();
    });

    connect();
  },

  deactivate() {
    // best-effort: до Cleanup хоста соединение ещё живо. «Очистить сущности
    // при выключении» — пустые retained-конфиги (штатное удаление в HA);
    // в любом случае устройство помечается offline.
    try {
      if (!g_mqtt || !g_mqtt.connected()) return;
      if (g_ctx && g_ctx.settings.get("cleanOnDisable")) {
        for (const obj of Object.keys(g_published))
          for (const comp of ["sensor", "binary_sensor", "event"])
            g_mqtt.publish("homeassistant/" + comp + "/usee_" + g_mid + "/" + obj + "/config", "",
                           { retain: true });
      }
      g_mqtt.publish("usee/" + g_mid + "/availability", "offline", { retain: true });
      g_mqtt.close();
    } catch (e) { /* закрытие не должно ронять остановку */ }
  },
});
