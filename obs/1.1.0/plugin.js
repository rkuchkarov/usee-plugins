// OBS Studio на приборе Usee: эфир, сцена, метры OBS и микрофон.
//
// obs-websocket встроен в OBS 30.2+: Tools → WebSocket Server Settings → «Enable
// WebSocket Server» (порт 4455, пароль — по желанию). Плагин — наблюдатель: в OBS
// уходят только рукопожатие и запросы на чтение. Ни StartRecord, ни
// SetCurrentProgramScene в коде нет вовсе — не для экономии: управление начнём
// писать тогда, когда у прибора появится ввод, и границы будет видно по факту.
//
// Протокол (на проводе ключи одинаковы в obs-websocket 5.x и 6.x):
//   op 0 Hello → op 1 Identify → op 2 Identified;
//   op 6 Request / op 7 RequestResponse; op 5 Event.
// Категории событий включает битовая маска в Identify — отдельной подписки нет.

const SUB_EVENTS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 6);   // General|Config|Scenes|Inputs|Outputs
const CONNECT_MS = 6000, REQUEST_MS = 4000, BACKOFF_MAX_SEC = 30;
const CURVE_POINTS = 90;                 // HISTORY_SIZE прошивки: столько точек держит кривая spark
const OUT = "OBS_WEBSOCKET_OUTPUT_";

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// obs-websocket: secret = base64(sha256(password + salt)), затем
// authentication = base64(sha256(secret + challenge)).
async function authString(password, salt, challenge) {
  const enc = new TextEncoder();
  const sha = async text => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  const secret = b64(await sha(password + salt));
  return b64(await sha(secret + challenge));
}

function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = n => (n < 10 ? "0" + n : "" + n);
  return h ? h + ":" + two(m) + ":" + two(s) : two(m) + ":" + two(s);
}

function fixed(n, digits) { return n.toFixed(digits).replace(".", ","); }

// Заполнение бара — целым процентом: дробь (0,01% скипнутых) уезжала бы на прибор
// длинным float, а бар от неё не меняется.
function bar(pct) { return Math.max(0, Math.min(100, Math.round(pct))); }

function gigas(bytes) {
  const g = bytes / 1073741824;
  return fixed(g, g >= 10 ? 0 : 1) + " ГБ";
}

function baseName(path) {
  const s = String(path || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

// §12 ТЗ: буферы прошивки фиксированные, а `utf8Copy` (include/card_slots.h,
// CS_CAP = sizeof поля − 1) режет сверху молча — ошибки ни в логе агента, ни в
// отказе карточки не будет, пользователь получит оборванное слово. Знаки тут
// считаем байтами UTF-8: кириллица — 2 байта, и «7,2 Мбит/с» в поле sec[12]
// влезает только как «7 Мбит».
const enc = new TextEncoder();
const LINE1_BYTES = 39, LINE2_BYTES = 71, DETAIL_BYTES = 36;   // status line1[40]/line2[72]/detail[40]
const SEC_BYTES = 11, FOOT_BYTES = 47;                         // meters sec[12]/footer[48]
const TOAST_TITLE_BYTES = 39, TOAST_SUB_BYTES = 47;            // config.h TOAST_TITLE_MAX/TOAST_SUB_MAX

function clip(s, maxBytes) {
  const t = String(s == null ? "" : s);
  if (enc.encode(t).length <= maxBytes) return t;
  let out = "", used = 0;
  for (const ch of t) {                  // по кодпоинтам: суррогатную пару не режем пополам
    const b = enc.encode(ch).length;
    if (used + b > maxBytes) break;
    out += ch; used += b;
  }
  return out;
}

// Первая строка, которая влезает ЦЕЛИКОМ: обрезанная выглядит как баг,
// короткая — как формат.
function firstFit(list, maxBytes) {
  for (const s of list) if (enc.encode(s).length <= maxBytes) return s;
  return clip(list[list.length - 1], maxBytes);
}

// sec[12]: 10 240 МБ — это 12 байт, поэтому объём переезжает в ГБ.
function memSec(mb) { return firstFit([fixed(mb, 0) + " МБ", fixed(mb / 1024, 1) + " ГБ", fixed(mb / 1024, 0) + "ГБ"], SEC_BYTES); }

// sec[12]: «12734 кдр» — 12 байт; дробь тысячнее, чем «128 к».
function skippedSec(n) {
  return firstFit([n + " кдр", fixed(n / 1000, 1) + " кдр", Math.round(n / 1000) + " к", String(n)], SEC_BYTES);
}

// sec[12]: целое число Мбит — максимум, что остаётся после разделителя;
// точное значение с знаком после запятой живёт в footer[48].
function bitSec(kbps) {
  return firstFit([Math.round(kbps / 1000) + " Мбит", fixed(kbps / 1000, 1), String(Math.round(kbps))], SEC_BYTES);
}

definePlugin({
  cards: {
    obs: {
      label: "OBS · эфир", type: "status",
      fields: {
        state: { label: "Состояние OBS", kind: "string" },
        is_on: { label: "Запись или эфир идут", kind: "bool" },
        number: { label: "Длительность текущего вывода, сек", kind: "number" },
      },
    },
    fps: {
      label: "OBS · кадры", type: "spark",
      fields: { number: { label: "Кадров в секунду", kind: "number", unit: "к/с" } },
    },
    stats: { label: "OBS · метры", type: "meters" },
    mic: {
      label: "OBS · микрофон", type: "status",
      fields: {
        state: { label: "Микрофон", kind: "string" },
        is_on: { label: "Микрофон включён", kind: "bool" },
      },
    },
  },

  activate(ctx) {
    const notify = String(ctx.settings.get("notify") || "outputs");
    const micName = String(ctx.settings.get("micInput") || "").trim();
    const wantMic = ctx.settings.get("showMic") !== false && micName !== "";

    // ---- соединение ----
    let sock = null, up = false, backoffSec = 0, retryAt = 0, lastErr = "";
    const reqs = new Map();

    // ---- что известно об OBS ----
    let has = null;                                   // availableRequests из GetVersion
    let rec = null, stream = null, stats = null;      // {active, paused, ms, at}
    let scene = "", studio = false, profile = "", collection = "";
    let micMuted = null, micDb = null, micMissing = false;
    let fps = null, fpsTarget = null, fpsTargetTried = false;
    let bitKbps = null, bitPrev = null;
    let tallyKey = "", tallyAt = 0;

    function endpoint() {
      const host = String(ctx.settings.get("host") || "127.0.0.1").trim();
      const port = Number(ctx.settings.get("port") || 4455) || 4455;
      return "ws://" + host + ":" + port;
    }

    // availableRequests OBS отдаёт сам — на них и ориентируемся: то, чего в этой
    // версии нет, не спрашиваем вовсе (5.5.6 и 6.x отличаются набором).
    function hasRequest(name) { return has === null || has.indexOf(name) >= 0; }

    function sendRequest(type, data) {
      return new Promise((resolve, reject) => {
        if (!sock) { reject(new Error("OBS: нет соединения")); return; }
        const id = crypto.randomUUID();
        const timer = ctx.timers.setTimeout(() => {
          reqs.delete(id);
          reject(new Error("OBS: «" + type + "» не ответил за " + (REQUEST_MS / 1000) + " с"));
        }, REQUEST_MS);
        reqs.set(id, { resolve, reject, timer });
        const msg = { op: 6, d: { requestType: type, requestId: id } };
        if (data) msg.d.requestData = data;
        sock.send(JSON.stringify(msg));
      });
    }

    function dropSocket(s, why) {
      if (sock !== s) return;                   // опоздал старым сокетом
      sock = null; up = false; lastErr = "OBS: " + why;
      for (const id of Array.from(reqs.keys())) {
        const r = reqs.get(id);
        reqs.delete(id);
        ctx.timers.clear(r.timer);
        r.reject(new Error("OBS: соединение потеряно (" + why + ")"));
      }
    }

    async function identify(s, hello) {
      const d = { rpcVersion: Number(hello.rpcVersion) || 1, eventSubscriptions: SUB_EVENTS };
      const auth = hello.authentication;
      if (auth && auth.salt && auth.challenge) {
        const pass = String(ctx.settings.get("password") || "");
        if (!pass) throw new Error("в OBS включён пароль WebSocket-сервера — введите его в настройках плагина");
        d.authentication = await authString(pass, auth.salt, auth.challenge);
      }
      s.send(JSON.stringify({ op: 1, d }));
    }

    function connect() {
      return new Promise((resolve, reject) => {
        let s;
        try { s = ctx.net.ws(endpoint()); } catch (e) { reject(e); return; }
        let settled = false;
        const fail = why => {
          if (settled) return;
          settled = true;
          ctx.timers.clear(timer);
          try { s.close(); } catch (e) { /* уже закрыт */ }
          reject(new Error("OBS: " + why));
        };
        const timer = ctx.timers.setTimeout(() => fail("«" + endpoint() + "» молчит " + (CONNECT_MS / 1000) + " с"), CONNECT_MS);

        s.on("message", text => {
          let m;
          try { m = JSON.parse(text); } catch (e) { return; }
          const d = (m && m.d) || {};
          if (m.op === 0) { identify(s, d).catch(err => fail(String((err && err.message) || err))); return; }
          if (m.op === 2) {
            if (settled) return;
            settled = true;
            ctx.timers.clear(timer);
            sock = s; up = true; backoffSec = 0; lastErr = "";
            resolve();
            return;
          }
          if (settled) dispatch(m);
        });
        s.on("close", why => { dropSocket(s, why || "соединение закрыто"); fail(why || "соединение закрыто"); });
        s.on("error", why => { dropSocket(s, why); fail(why); });
      });
    }

    function dispatch(m) {
      const d = (m && m.d) || {};
      if (m.op === 7) {
        const p = reqs.get(d.requestId);
        if (!p) return;
        reqs.delete(d.requestId);
        ctx.timers.clear(p.timer);
        const st = d.requestStatus || {};
        if (st.result === false) p.reject(new Error("OBS: " + (d.requestType || "?") + " — " + (st.comment || "код " + st.code)));
        else p.resolve(d.responseData || {});
        return;
      }
      if (m.op === 5) onEvent(String(d.eventType || ""), d.eventData || {});
    }

    // ---- карточки ----
    // Буферы тоста тоже фиксированные (TOAST_TITLE_MAX 40 / TOAST_SUB_MAX 48), а
    // хост их не режет — режет прошивка, молча.
    function toast(kind, title, sub) {
      if (notify === "off") return;
      ctx.toast(kind, clip(title, TOAST_TITLE_BYTES),
                sub == null ? undefined : clip(String(sub), TOAST_SUB_BYTES), 6000);
    }

    // Длительность вывода: OBS отдаёт счётчик на момент ответа, дальше он идёт
    // локально — иначе счётчик прыгал бы разами по интервалу опроса.
    function elapsed(out) {
      if (!out || !out.active) return null;
      return out.paused ? out.ms : out.ms + (Date.now() - out.at);
    }

    // Строка таймера целиком — и рендер, и секундный тик считают её одинаково.
    function tally() {
      const recOn = !!(rec && rec.active), liveOn = !!(stream && stream.active);
      const main = elapsed(recOn ? rec : liveOn ? stream : null);
      return { recOn: recOn, liveOn: liveOn, main: main,
               line1: (recOn ? "REC " : liveOn ? "LIVE " : "OBS") +
                      (main != null ? clock(main) : (studio ? "STUDIO" : "")) };
    }

    // Какие карточки плагина опубликованы прямо сейчас. Патч по неопубликованной
    // — ошибка хоста, а remove() по снятой — шум в логе, поэтому и то, и другое
    // делаем только по этому флагу.
    const shown = { obs: false, fps: false, stats: false, mic: false };
    let renderedLine = "";      // line1, которая реально на карточке сейчас

    // Счётчик записи/эфира ведём сами и перерисовываем раз в секунду: OBS отдаёт
    // длительность только на момент ответа, а карточка обновляется только когда
    // payload изменился. Без этого тика «REC 02:03 → 02:05 → 02:07» шло шагами по
    // интервалу опроса (2 с по умолчанию) — выглядит как отставание прибора.
    ctx.timers.setInterval(() => {
      if (!shown.obs) return;
      const t = tally();
      if (t.line1 === renderedLine) return;
      renderedLine = t.line1;
      const p = { line1: t.line1 };
      if (t.main != null) p.number = Math.floor(t.main / 1000);
      ctx.cards.obs.patch(p, { immediate: true });
    }, 1000);

    // Событие может прийти раньше первого опроса (сменили сцену в ту же секунду,
    // что подключились), поэтому первая публикация — всегда set.
    function render(immediate) {
      const t = tally();
      const recOn = t.recOn, liveOn = t.liveOn;
      const main = t.main;

      let badge, badgeKind;
      if (stream && stream.active && stream.reconnecting) { badge = "РЕКОНН"; badgeKind = "net"; }
      else if (recOn && rec.paused) { badge = "ПАУЗА"; badgeKind = "plain"; }
      else if (recOn && liveOn) { badge = "LIVE"; badgeKind = "net"; }
      else if (studio && !recOn && !liveOn) { badge = "STUDIO"; badgeKind = "plain"; }

      const payload = {
        icon: recOn ? "record" : liveOn ? "upload" : (studio ? "pause" : "stop"),
        line1: t.line1,
        line2: scene ? clip(scene, LINE2_BYTES) : (up ? "нет сцены" : "нет связи"),
        state: !up ? "offline" : recOn ? "recording" : liveOn ? "live" : "idle",
        is_on: recOn || liveOn,
      };
      if (badge) { payload.badge = badge; payload.badgeKind = badgeKind; }
      if (main != null) payload.number = Math.floor(main / 1000);
      // Профиль и коллекция вместе влезают не всегда: вместо обрезанной строки
      // показываем то из них, что влезает.
      if (profile || collection) {
        payload.detail = firstFit([[profile, collection].filter(Boolean).join(" · "), profile, collection],
                                  DETAIL_BYTES);
      }
      if (tallyKey && tallyAt) payload.eventAt = tallyAt;

      if (immediate && shown.obs) ctx.cards.obs.patch(payload, { immediate: true });
      else { ctx.cards.obs.set(payload); shown.obs = true; }
      renderedLine = payload.line1;
    }

    function row(label, label16, pct, sec) {
      // Пустые поля не отправляем вовсе: строка без `sec` рисует бар и число,
      // а `sec: null` — то же самое, но мусором в payload.
      const r = { label: label, pct: pct, label16: label16 };
      if (sec) r.sec = sec;
      return r;
    }

    function renderStats() {
      if (!stats) {
        if (shown.stats) { ctx.cards.stats.remove(); shown.stats = false; }
        return;
      }
      const rows = [];
      const cpu = Number(stats.cpuUsage);
      if (Number.isFinite(cpu)) {
        rows.push(row("CPU", "OBS CPU", bar(cpu),
          Number.isFinite(Number(stats.memoryUsage)) ? memSec(Number(stats.memoryUsage)) : null));
      }
      const skipped = Number(stats.outputSkippedFrames), total = Number(stats.outputTotalFrames);
      if (Number.isFinite(skipped) && Number.isFinite(total) && total > 0) {
        rows.push(row("СКИП", "ПРОПУЩ. КАДРЫ", bar((skipped / total) * 100), skippedSec(skipped)));
      }
      const live = stream && stream.active;
      const cong = live ? stream.congestion : null;
      if (cong !== null && cong !== undefined && Number.isFinite(cong)) {
        rows.push(row("СЕТЬ", "КОНЖЕСТИЯ", bar(cong * 100), bitKbps != null ? bitSec(bitKbps) : null));
      }
      if (!rows.length) {
        if (shown.stats) { ctx.cards.stats.remove(); shown.stats = false; }
        return;
      }
      const parts = [];
      const free = Number(stats.availableDiskSpace);
      if (Number.isFinite(free)) parts.push("диск " + gigas(free));
      if (bitKbps != null && live) parts.push(fixed(bitKbps / 1000, 1) + " Мбит/с");
      ctx.cards.stats.set({ rows: rows.slice(0, 4),
                            footer: parts.length ? firstFit([parts.join(" · "), parts[0]], FOOT_BYTES) : undefined });
      shown.stats = true;
    }

    function renderMic(immediate) {
      if (!wantMic || micMissing || micMuted === null) {
        if (shown.mic) { ctx.cards.mic.remove(); shown.mic = false; }
        return;
      }
      const payload = {
        icon: "mic",
        line1: "MICRO",
        line2: micMuted ? "замутен" : (micDb !== null ? fixed(micDb, 1) + " дБ" : "включён"),
        state: micMuted ? "muted" : "on",
        is_on: !micMuted,
      };
      if (micMuted) { payload.badge = "MUTE"; payload.badgeKind = "rec"; }
      if (immediate && shown.mic) ctx.cards.mic.patch(payload, { immediate: true });
      else { ctx.cards.mic.set(payload); shown.mic = true; }
    }

    function renderFps() {
      if (fps === null || !Number.isFinite(fps)) {
        if (shown.fps) { ctx.cards.fps.remove(); shown.fps = false; }
        return;
      }
      const n = Math.round(fps);
      ctx.cards.fps.set({ label: "КАДРЫ", number: n, unit: "к/с",
                          windowSec: CURVE_POINTS * (Number(ctx.settings.get("intervalSec")) || 2),
                          state: String(n) });
      // Точка ряда — само значение (байт): масштаб кривой прошивка подбирает сама,
      // поэтому 240 к/с в ряд влезает, а 300 — уже нет; такой тик остаётся без точки.
      if (n <= 255) ctx.cards.fps.history(n);
      shown.fps = true;
    }

    function renderOffline() {
      render(false);
      if (shown.fps) { ctx.cards.fps.remove(); shown.fps = false; }
      if (shown.stats) { ctx.cards.stats.remove(); shown.stats = false; }
      if (shown.mic) { ctx.cards.mic.remove(); shown.mic = false; }
    }

    // Смена tally (запись/эфир) — момент, который карточка подписывает «N МИН НАЗАД».
    function tallyFlip() {
      const key = (rec && rec.active ? "r" : "") + (stream && stream.active ? "l" : "");
      if (key !== tallyKey) { tallyKey = key; tallyAt = Math.floor(Date.now() / 1000); }
    }

    function outState(prev, active, state) {
      const on = !!active;
      return {
        active: on,
        paused: state === OUT + "PAUSED",
        reconnecting: state === OUT + "RECONNECTING",
        congestion: prev ? prev.congestion : null,   // события его не носят — держим последний замер
        ms: prev && prev.active === on ? prev.ms : 0,
        at: Date.now(),
      };
    }

    function onEvent(type, d) {
      const out = String(d.outputState || "").slice(OUT.length);
      if (type === "RecordStateChanged") {
        rec = outState(rec, d.outputActive, d.outputState);
        tallyFlip(); render(true);
        if (notify !== "off") {
          if (out === "STARTED") toast("done", "ЗАПИСЬ ПОШЛА", scene || undefined);
          else if (out === "STOPPED") toast("notice", "запись остановлена", d.outputPath ? baseName(d.outputPath) : undefined);
          else if (out === "PAUSED") toast("notice", "запись на паузе");
          else if (out === "RESUMED") toast("notice", "запись продолжается");
        }
        return;
      }
      if (type === "StreamStateChanged") {
        stream = outState(stream, d.outputActive, d.outputState);
        tallyFlip();
        if (!stream.active) { bitKbps = null; bitPrev = null; }
        render(true);
        if (notify !== "off") {
          if (out === "STARTED") toast("done", "ЭФИР ПОШЁЛ", scene || undefined);
          else if (out === "RECONNECTING") toast("critical", "ЭФИР ТЕРЯЕТСЯ");
          else if (out === "RECONNECTED") toast("done", "эфир восстановлен");
          else if (out === "RECONNECT_FAILURE" || out === "CANCELLING") toast("critical", "эфир оборвался");
          else if (out === "STOPPED") toast("notice", "эфир остановлен");
        }
        return;
      }
      if (type === "ReplayBufferStateChanged") {
        if (notify !== "off" && out === "STARTED") toast("notice", "буфер реплея включён");
        return;
      }
      if (type === "ReplayBufferSaved") {
        if (notify !== "off") toast("done", "РЕПЛЕЙ СОХРАНЁН", baseName(d.savedReplayPath));
        return;
      }
      if (type === "CurrentProgramSceneChanged") {
        if (d.sceneName) scene = String(d.sceneName);
        render(true);
        return;
      }
      if (type === "StudioModeStateChanged") { studio = !!d.studioModeEnabled; render(true); return; }
      if (type === "CurrentProfileChanged") { profile = String(d.profileName || ""); render(true); return; }
      if (type === "CurrentSceneCollectionChanged") { collection = String(d.sceneCollectionName || ""); render(true); return; }
      if (type === "InputMuteStateChanged" && String(d.inputName || "") === micName) {
        micMuted = !!d.inputMuted;
        renderMic(true);
      }
    }

    // Редко меняющееся: версии, режим студия, профиль, коллекция, список входов,
    // целевой FPS. Ошибки не роняют тик — чего нет в этой версии OBS, того нет и
    // на карточке.
    async function probe() {
      const v = await sendRequest("GetVersion").catch(() => null);
      if (v) {
        has = Array.isArray(v.availableRequests) ? v.availableRequests : null;
        if (v.obsWebSocketVersion) ctx.log.info("obs-websocket " + v.obsWebSocketVersion +
          (v.obsVersion ? ", OBS " + v.obsVersion : "") + (v.platform ? " на " + v.platform : ""));
      }
      if (hasRequest("GetStudioModeEnabled")) {
        const sm = await sendRequest("GetStudioModeEnabled").catch(() => null);
        if (sm) studio = !!sm.studioModeEnabled;
      }
      if (hasRequest("GetProfileList")) {
        const p = await sendRequest("GetProfileList").catch(() => null);
        if (p) profile = String(p.currentProfileName || "");
      }
      if (hasRequest("GetSceneCollectionList")) {
        const c = await sendRequest("GetSceneCollectionList").catch(() => null);
        if (c) collection = String(c.currentSceneCollectionName || "");
      }
      if (wantMic && hasRequest("GetInputList")) {
        const l = await sendRequest("GetInputList").catch(() => null);
        if (l && Array.isArray(l.inputs)) {
          const known = l.inputs.some(i => String(i.inputName || "") === micName);
          if (!known && !micMissing) {
            micMissing = true;
            ctx.log.warn("в OBS нет входа «" + micName + "» — карточка микрофона снята;" +
              " входов: " + l.inputs.slice(0, 6).map(i => i.inputName).join(", "));
          }
        }
      }
      if (!fpsTargetTried) {
        fpsTargetTried = true;
        const den = await probeParam("fps_den"), num = await probeParam("fps_num");
        if (num !== null && den !== null && den > 0) {
          const t = num / den;
          if (t >= 1 && t <= 240) fpsTarget = t;
        }
      }
    }

    async function probeParam(name) {
      if (!hasRequest("GetProfileParameter")) return null;
      const r = await sendRequest("GetProfileParameter", { parameterCategory: "Video", parameterName: name })
        .catch(() => null);
      const v = Number(r && (r.parameterValue !== undefined ? r.parameterValue : r.defaultParameterValue));
      return r && Number.isFinite(v) ? v : null;
    }

    ctx.poll(async () => {
      if (!up) {
        if (Date.now() < retryAt) throw new Error(lastErr || "OBS: нет соединения");
        try {
          await connect();
          await probe();
          rec = stream = stats = null;
          micMuted = null; micDb = null; bitKbps = null; bitPrev = null; tallyKey = ""; tallyAt = 0;
        } catch (e) {
          lastErr = String((e && e.message) || e);
          backoffSec = Math.min(BACKOFF_MAX_SEC, backoffSec ? backoffSec * 2 : 2);
          retryAt = Date.now() + backoffSec * 1000;
          rec = stream = stats = null; micMuted = null; bitKbps = null; fps = null;
          renderOffline();
          throw new Error(lastErr);
        }
      }

      // Каждый тик — только то, что живёт на экране. Ошибка одного запроса не
      // снимает остальные: OBS отвечает выборочно (у сборок разный набор).
      const got = await Promise.all([
        sendRequest("GetStats").catch(() => null),
        hasRequest("GetRecordStatus") ? sendRequest("GetRecordStatus").catch(() => null) : Promise.resolve(null),
        hasRequest("GetStreamStatus") ? sendRequest("GetStreamStatus").catch(() => null) : Promise.resolve(null),
        hasRequest("GetCurrentProgramScene") ? sendRequest("GetCurrentProgramScene").catch(() => null) : Promise.resolve(null),
      ]);
      const st = got[0], recR = got[1], strR = got[2], scR = got[3];
      if (st === null && recR === null && strR === null && scR === null) {
        dropSocket(sock, "запросы не проходят");
        throw new Error("OBS: соединение есть, а ответов нет");
      }

      if (st) stats = st;
      if (recR) rec = { active: !!recR.outputActive, paused: !!recR.outputPaused,
                        reconnecting: false, ms: Number(recR.outputDuration) || 0, at: Date.now() };
      if (strR) {
        stream = { active: !!strR.outputActive, paused: false, reconnecting: !!strR.outputReconnecting,
                   congestion: Number.isFinite(Number(strR.outputCongestion)) ? Number(strR.outputCongestion) : null,
                   ms: Number(strR.outputDuration) || 0, at: Date.now() };
        // Битрейт — дельта счётчика отправленных байт: самого битрейта в GetStreamStatus нет.
        const bytes = Number(strR.outputBytes);
        const on = stream.active && Number.isFinite(bytes);
        if (on && bitPrev !== null && Date.now() > bitPrev.at && bytes >= bitPrev.bytes) {
          const inst = ((bytes - bitPrev.bytes) * 8) / 1000 / ((Date.now() - bitPrev.at) / 1000);   // кбит/с
          bitKbps = bitKbps === null ? inst : bitKbps * 0.6 + inst * 0.4;
        }
        bitPrev = on ? { bytes, at: Date.now() } : null;
        if (!stream.active) bitKbps = null;
      }
      if (scR && scR.sceneName) scene = String(scR.sceneName);
      if (st && Number.isFinite(Number(st.activeFps))) fps = Number(st.activeFps);
      tallyFlip();
      render(false);
      renderStats();

      if (wantMic && !micMissing && ctx.cards.placed().indexOf("mic") >= 0 && hasRequest("GetInputMute")) {
        const m = await sendRequest("GetInputMute", { inputName: micName }).catch(() => null);
        if (m === null) micMuted = null;
        else {
          micMuted = !!m.inputMuted;
          if (hasRequest("GetInputVolume")) {
            const vol = await sendRequest("GetInputVolume", { inputName: micName }).catch(() => null);
            micDb = vol && Number.isFinite(Number(vol.inputVolumeDb)) ? Number(vol.inputVolumeDb) : null;
          }
        }
      }
      renderMic(false);

      // Кривая кадров нужна только когда карточка в раскладке: точка ряда — это
      // значение, и копить ряд ради карточки, которую никто не смотрит, незачем.
      if (fps !== null && ctx.cards.placed().indexOf("fps") >= 0) renderFps();
      else if (shown.fps) { ctx.cards.fps.remove(); shown.fps = false; }

      const recOn = !!(rec && rec.active), liveOn = !!(stream && stream.active);
      return "OBS · " + (recOn ? "REC " + clock(elapsed(rec)) : liveOn ? "LIVE " + clock(elapsed(stream)) : "ожидание") +
        (scene ? " · " + scene : "") + (fpsTarget ? " · цель " + fixed(fpsTarget, 0) + " к/с" : "");
    }, { everySetting: "intervalSec" });
  },
});
