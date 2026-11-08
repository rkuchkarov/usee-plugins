// OBS Studio на приборе Usee: эфир, сцена, метры OBS и микрофон.
//
// obs-websocket встроен в OBS 30.2+: Tools → WebSocket Server Settings → «Enable
// WebSocket Server» (порт 4455, пароль — по желанию). Плагин — наблюдатель: в OBS
// уходят только рукопожатие и запросы на чтение. Ни StartRecord, ни
// SetCurrentProgramScene в коде нет вовсе — не для экономии: управление начнём
// писать тогда, когда у прибора появится ввод, и границы будет видно по факту.
//
// 1.5.0 (SDK 11): опрос спит, пока OBS не запущен (permissions.apps, whileApp) — не
// стучимся в закрытый порт раз в секунду; закрылся OBS — карточки снимаются сразу; OBS
// запущен, но молчит — значит, выключен WebSocket-сервер, это говорится прямо. Тексты —
// вариантами: ёмкость полей прибора знает хост (своя таблица байтов снята).
//
// Протокол (на проводе ключи одинаковы в obs-websocket 5.x и 6.x):
//   op 0 Hello → op 1 Identify → op 2 Identified;
//   op 6 Request / op 7 RequestResponse; op 5 Event.
// Категории событий включает битовая маска в Identify — отдельной подписки нет.

const SUB_EVENTS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 6);   // General|Config|Scenes|Inputs|Outputs
const CONNECT_MS = 6000, REQUEST_MS = 4000, BACKOFF_MAX_SEC = 30;
const CURVE_POINTS = 90;                 // HISTORY_SIZE прошивки: столько точек держит кривая spark
// Опрос раз в секунду зашит (1.4.0): таймер записи идёт локально, состояние приходит событиями,
// опрос нужен метрам и кривой кадров — выбирать тут человеку нечего (как в poe2-farm 0.5.1).
const POLL_SEC = 1;
const OUT = "OBS_WEBSOCKET_OUTPUT_";

// Красная иконка микрофона при mute (24×24, little-endian RGB565 на фоне #23272E).
// Зарегистрирована через ctx.cards.icon("mic-red", ...), чтобы работать и на старых хостах.
const RED_MIC_ICON = "24x24,JSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSGnYWrSy/pq0qdhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhZkHL+sv6y/rL+sv6ZkElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUh6IHL+sv6y/rL+sv66IElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhCJLL+sv6y/rL+sv6CJIlISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhCJLL+sv6y/rL+sv6CJIlISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhCJLL+sv6y/rL+sv6CJIlISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhCJLL+sv6y/rL+sv6CJIlISUhJSElISUhJSElISUhJSElISUhJSElISUhp2GnYSUhCJLL+sv6y/rL+sv6CJIlIadhp2ElISUhJSElISUhJSElISUhJSElISUhquKr6iUhCJLL+sv6y/rL+sv6CJIlIavqquIlISUhJSElISUhJSElISUhJSElISUhKaLL+qdp6IHL+sv6y/rL+sv66IGnacv6KaIlISUhJSElISUhJSElISUhJSElISUhhlnL+mrKZkHL+sv6y/rL+sv6ZkFqysv6hlklISUhJSElISUhJSElISUhJSElISUhJSHL8sv6CJKnYWrSy/pq0qdhCJLL+svyJSElISUhJSElISUhJSElISUhJSElISUhJSHHearqy/qK2iiaasIImoray/qq4seBJSElISUhJSElISUhJSElISUhJSElISUhJSElIUUxitLL+sv6y/rL+sv6itJFMSUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSEIkkmyy/pJsgiSJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElIQiSy/oIkiUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElIcdxCJIIkmrKy/pqygiSCJLHcSUhJSElISUhJSElISUhJSElISUhJSElISUhJSElIcv6y/rL+sv6y/rL+sv6y/rL+iUhJSElISUhJSElISUhJSElISUhJSElISUhJSElIcdxCJIIkgiSCJIIkgiSCJLHcSUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUhJSElISUh";

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

// Вторичные значения строк метров — ВАРИАНТАМИ от точного к короткому: ёмкость поля
// прибора (sec — 11 байт) знает хост и берёт первый, что влезает (SDK 11). Прежде здесь
// жила своя таблица байтов буферов прошивки и своя обрезка.
function memSec(mb) { return [fixed(mb, 0) + " МБ", fixed(mb / 1024, 1) + " ГБ", fixed(mb / 1024, 0) + "ГБ"]; }
function skippedSec(n) { return [n + " кдр", fixed(n / 1000, 1) + " кдр", Math.round(n / 1000) + " к", String(n)]; }
function bitSec(kbps) { return [Math.round(kbps / 1000) + " Мбит", fixed(kbps / 1000, 1), String(Math.round(kbps))]; }

// kind входа OBS технический — человеку важно, микрофон это или звук системы.
const KIND_LABEL = {
  wasapi_input_capture: "микрофон · WASAPI",
  coreaudio_input_capture: "микрофон · CoreAudio",
  pulse_input_capture: "микрофон · PulseAudio",
  jack_input_capture: "микрофон · JACK",
  wasapi_output_capture: "звук системы · WASAPI",
  coreaudio_output_capture: "звук системы · CoreAudio",
  pulse_output_capture: "звук системы · PulseAudio",
};

// Снимок входов OBS: тот же список разбирает карточка, тот же отдаёт редактор
// настроек. Держим на уровне модуля — провайдер вызывается вне activate.
let obsInputs = null;

function listInputs() {
  if (!obsInputs) return [];
  return obsInputs.map(i => ({
    id: i.name,
    label: i.name,
    detail: (i.special ? "спец. вход OBS · " : "") + (KIND_LABEL[i.kind] || i.kind || "вход"),
  }));
}

definePlugin({
  cards: {
    obs: {
      label: "OBS · эфир", type: "status",
      fields: {
        state: { label: "Состояние OBS", kind: "string" },
        is_on: { label: "Запись или эфир идут", kind: "bool" },
        number: { label: "Длительность эфира или записи, сек", kind: "number" },
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
        // Положение фейдера входа в OBS, а не живой уровень сигнала (метры OBS шлёт событием
        // InputVolumeMeters 20 раз в секунду — не для прибора).
        number: { label: "Громкость входа в OBS, дБ", kind: "number" },
      },
    },
  },

  providers: { listInputs },   // подсказки в поле «Вход микрофона» (режим A: на ввод)

  activate(ctx) {
    ctx.cards.icon("mic-red", RED_MIC_ICON);
    const micWant = String(ctx.settings.get("micInput") || "").trim();
    // Карточка микрофона видна, если её поставили на сцену: отдельный переключатель дублировал
    // раскладку (1.4.0). Входы OBS читаются всё равно — ими кормятся подсказки поля.
    const wantMic = true;

    // ---- соединение ----
    let sock = null, up = false, backoffSec = 0, retryAt = 0, lastErr = "";
    // OBS не запущен (до Hello никто не ответил) — обычное состояние, а не ошибка плагина:
    // статус спокойный, карточек нет. Ошибка — когда OBS ответил, но войти не вышло.
    let notRunning = false;
    const reqs = new Map();

    // ---- что известно об OBS ----
    let has = null;                                   // availableRequests из GetVersion
    let rec = null, stream = null, stats = null;      // {active, paused, ms, at}
    let scene = "", studio = false, profile = "", collection = "";
    let micMuted = null, micDb = null, micMissing = false;
    let inputs = null, specials = null, micName = "";
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
        let hello = false;
        const fail = why => {
          if (settled) return;
          settled = true;
          ctx.timers.clear(timer);
          try { s.close(); } catch (e) { /* уже закрыт */ }
          const err = new Error("OBS: " + why);
          err.notRunning = !hello;
          reject(err);
        };
        const timer = ctx.timers.setTimeout(() => fail("«" + endpoint() + "» молчит " + (CONNECT_MS / 1000) + " с"), CONNECT_MS);

        s.on("message", text => {
          let m;
          try { m = JSON.parse(text); } catch (e) { return; }
          const d = (m && m.d) || {};
          if (m.op === 0) { hello = true; identify(s, d).catch(err => fail(String((err && err.message) || err))); return; }
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

    // Длительность вывода: OBS отдаёт счётчик на момент ответа, дальше он идёт
    // локально — иначе счётчик прыгал бы разами по интервалу опроса.
    function elapsed(out) {
      if (!out || !out.active) return null;
      return out.paused ? out.ms : out.ms + (Date.now() - out.at);
    }

    // Строка таймера целиком — и рендер, и секундный тик считают её одинаково.
    // Таймер сам по себе, без префикса: «кто именно идёт» говорит бейдж над ним.
    function tally() {
      const recOn = !!(rec && rec.active), liveOn = !!(stream && stream.active);
      // Если идут и запись, и эфир, таймер — про эфир: он же и бейдж «LIVE».
      const main = elapsed(liveOn ? stream : recOn ? rec : null);
      return { recOn: recOn, liveOn: liveOn, main: main,
               line1: main != null ? clock(main) : "Эфир" };
    }

    // Бейдж — это «в эфире»: красным и с пульсирующей точкой (BADGE_REC в прошивке
    // — красный текст + точка, src/cards.h:41). На экране он один такой, и по нему
    // с порога видно, что OBS что-то выводит. Пауза и студия — серый: вывода нет.
    function badgeOf(recOn, liveOn) {
      if (liveOn && stream.reconnecting) return { text: "РЕКОНН", kind: "rec" };
      if (liveOn) return { text: "LIVE", kind: "rec" };
      if (recOn && rec.paused) return { text: "ПАУЗА", kind: "plain" };
      if (recOn) return { text: "REC", kind: "rec" };
      if (studio) return { text: "STUDIO", kind: "plain" };
      return null;
    }

    // Какие карточки плагина опубликованы прямо сейчас. Патч по неопубликованной
    // — ошибка хоста, а remove() по снятой — шум в логе, поэтому и то, и другое
    // делаем только по этому флагу.
    const shown = { obs: false, fps: false, stats: false, mic: false };
    const lastSig = {};

    // Демпфер payload: одинаковый payload не шлём каждый такт, но не реже раза
    // в 5 секунд обновляем карточку (heartbeat), иначе хост сочтёт её устаревшей
    // (stalenessSec: 15..30 с) и снимет с экрана в простое (D-108).
    const HEARTBEAT_MS = 5000;
    const CARD_OPTS = { stalenessSec: 30 };

    function fresh(id, payload) {
      const sig = JSON.stringify(payload);
      const now = Date.now();
      const last = lastSig[id];
      if (!last || last.sig !== sig || now - last.at >= HEARTBEAT_MS) {
        lastSig[id] = { sig, at: now };
        return true;
      }
      return false;
    }

    function dropCard(id) {
      if (!shown[id]) return;
      ctx.cards[id].remove();
      shown[id] = false;
      delete lastSig[id];           // карточка может вернуться — её надо послать заново
    }

    // Счётчик записи/эфира живёт и между опросами: тикаем каждую секунду, только
    // когда запись или эфир действительно идут. Лишний кадр отсекает fresh.
    ctx.timers.setInterval(() => {
      if (shown.obs && ((rec && rec.active) || (stream && stream.active))) {
        render(true);
      }
    }, 1000);

    // Событие может прийти раньше первого опроса (сменили сцену в ту же секунду,
    // что подключились), поэтому первая публикация — всегда set.
    function render(immediate) {
      const t = tally();
      const recOn = t.recOn, liveOn = t.liveOn;
      const main = t.main;

      // Offline — без бейджа: «STUDIO» из прошлого соединения не должен
      // переживать потерю связи.
      const bd = up ? badgeOf(recOn, liveOn) : null;

      const payload = {
        // Под бейджем «rec» прошивка рисует в иконной зоне пульсирующую точку вместо
        // иконки — иконка работает только там, где вывода нет или он на паузе.
        icon: recOn ? "record" : liveOn ? "upload" : (studio ? "pause" : "stop"),
        line1: t.line1,
        line2: scene || (up ? "нет сцены" : "нет связи"),
        badge: bd ? bd.text : "",
        badgeKind: bd ? bd.kind : "plain",
        eventAt: (tallyKey && tallyAt) ? tallyAt : 0,
        detail: (profile || collection)
          ? [[profile, collection].filter(Boolean).join(" · "), profile, collection].filter(Boolean)
          : "",
        state: !up ? "offline" : liveOn ? "live" : recOn ? "recording" : "idle",
        is_on: recOn || liveOn,
        number: main != null ? Math.floor(main / 1000) : 0,
      };

      if (!fresh("obs", payload)) return;
      if (immediate && shown.obs) ctx.cards.obs.patch(payload, { immediate: true });
      else { ctx.cards.obs.set(payload, CARD_OPTS); shown.obs = true; }
    }

    function row(label, label16, pct, sec) {
      // Пустые поля не отправляем вовсе: строка без `sec` рисует бар и число,
      // а `sec: null` — то же самое, но мусором в payload.
      const r = { label: label, pct: pct, label16: label16 };
      if (sec) r.sec = sec;
      return r;
    }

    function renderStats() {
      if (!stats) { dropCard("stats"); return; }
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
      if (!rows.length) { dropCard("stats"); return; }
      const parts = [];
      const free = Number(stats.availableDiskSpace);
      if (Number.isFinite(free)) parts.push("диск " + gigas(free));
      if (bitKbps != null && live) parts.push(fixed(bitKbps / 1000, 1) + " Мбит/с");
      const p = { rows: rows.slice(0, 4),
                  footer: parts.length ? [parts.join(" · "), parts[0]] : undefined };
      if (!fresh("stats", p)) return;
      ctx.cards.stats.set(p, CARD_OPTS);
      shown.stats = true;
    }

    function renderMic(immediate) {
      if (!wantMic || micMissing || !micName || micMuted === null) { dropCard("mic"); return; }
      const payload = {
        icon: micMuted ? "mic-red" : "mic",
        line1: micMuted ? "MUTE" : (micDb !== null ? fixed(micDb, 1) + " дБ" : "включён"),
        // Имя входа — чтобы на экране было видно, О КАКОМ микрофоне карточка. Своих
        // имён плагин не выдумывает: как OBS назвал вход, так и подписано.
        line2: micName,
        badge: "mic",
        badgeKind: "plain",
        state: micMuted ? "muted" : "on",
        is_on: !micMuted,
      };
      if (micDb !== null) payload.number = micDb;
      if (!fresh("mic", payload)) return;
      if (immediate && shown.mic) ctx.cards.mic.patch(payload, { immediate: true });
      else { ctx.cards.mic.set(payload, CARD_OPTS); shown.mic = true; }
    }

    function renderFps() {
      if (fps === null || !Number.isFinite(fps)) { dropCard("fps"); return; }
      const n = Math.round(fps);
      const p = { label: "КАДРЫ", number: n, unit: "к/с",
                  windowSec: CURVE_POINTS * POLL_SEC,
                  state: String(n) };
      if (fresh("fps", p)) { ctx.cards.fps.set(p, CARD_OPTS); shown.fps = true; }
      // Точка ряда — само значение (байт): масштаб кривой прошивка подбирает сама,
      // поэтому 240 к/с в ряд влезает, а 300 — уже нет; такой тик остаётся без точки.
      // Ряд едет и когда карточка не менялась: кривая без новых точек стоит.
      if (n <= 255) ctx.cards.fps.history(n);
    }

    function renderOffline() {
      render(false);
      dropCard("fps");
      dropCard("stats");
      dropCard("mic");
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
      if (type === "RecordStateChanged") {
        rec = outState(rec, d.outputActive, d.outputState);
        tallyFlip(); render(true);
        return;
      }
      if (type === "StreamStateChanged") {
        stream = outState(stream, d.outputActive, d.outputState);
        tallyFlip();
        if (!stream.active) { bitKbps = null; bitPrev = null; }
        render(true);
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
      if (type === "InputVolumeChanged" && String(d.inputName || "") === micName) {
        if (d.inputVolumeDb !== undefined && Number.isFinite(Number(d.inputVolumeDb))) {
          micDb = Number(d.inputVolumeDb);
          renderMic(true);
        }
      }
    }

    // ---- какой вход OBS считает микрофоном ----
    // Имена входов придумывает пользователь, поэтому порядок такой: явная настройка →
    // спец. вход Mic/Aux (его называет сам OBS) → единственный вход захвата. По
    // «похожести» имени не гадаем: угаданный микрофон хуже честного «не понятно».
    async function readInputs() {
      if (!hasRequest("GetInputList")) return;
      const l = await sendRequest("GetInputList").catch(() => null);
      inputs = l && Array.isArray(l.inputs)
        ? l.inputs
            .map(i => ({ name: String(i.inputName || ""), kind: String(i.inputKind || "") }))
            .filter(i => i.name !== "")
        : null;
      specials = hasRequest("GetSpecialInputs")
        ? await sendRequest("GetSpecialInputs").catch(() => null)
        : null;
      if (!inputs) { ctx.log.warn("OBS не вернул список входов"); return; }
      obsInputs = inputs.map(i => ({ name: i.name, kind: i.kind, special: specialRole(i.name) !== "" }));
      pickMic();
      ctx.log.info("входы OBS: " + inputs.map(i => i.name + " [" + (KIND_LABEL[i.kind] || i.kind) + "]").join(", "));
    }

    function specialRole(name) {        // имя → роль спец. входа OBS ('' — не спец)
      if (!specials) return "";
      for (const role of ["mic1", "mic2", "mic3", "mic4", "desktop1", "desktop2"]) {
        if (specials[role] && String(specials[role]) === name) return role;
      }
      return "";
    }

    function pickMic() {
      if (!inputs) return;
      if (micWant) { micName = micWant; return; }
      const sp = specials && specials.mic1 ? String(specials.mic1) : "";
      const cap = inputs.filter(i => /input_capture$/.test(i.kind));
      if (sp && inputs.some(i => i.name === sp)) micName = sp;
      else if (cap.length === 1) micName = cap[0].name;
      else micName = "";
    }

    // Выбранный вход на месте? Если в OBS его переименовали или входов захвата
    // несколько и спец-входа нет — карточку не рисуем и говорим, почему.
    function micCheck() {
      if (!wantMic || !inputs) { micMissing = false; return; }
      if (micName && inputs.some(i => i.name === micName)) { micMissing = false; return; }
      if (!micMissing) {
        micMissing = true;
        ctx.log.warn(micWant
          ? "в OBS нет входа «" + micWant + "»; входы: " + inputs.map(i => i.name).join(", ")
          : "не понятно, какой вход микрофон (" + inputs.map(i => i.name).join(", ")
            + ") — укажи имя в настройках, там подсказки");
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
      // Входы читаем и когда карточки микрофона нет: тем же снимком кормится
      // редактор настроек (подсказки), и читается он раз на подключение.
      await readInputs();
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

    const idleText = () => "OBS не запущен — жду (" + endpoint() + ")";

    // Запущен ли OBS, видно только у СВОЕГО ПК: OBS на другом адресе процессом здесь не
    // числится — для него опрос не спит, как прежде.
    const host = String(ctx.settings.get("host") || "127.0.0.1").trim().toLowerCase();
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    const obsRunning = () => !local || ctx.apps.running();

    // OBS закрылся — карточки уходят сразу (опрос уснёт до его запуска); запустился —
    // подключаемся сразу, без накопленной отсрочки.
    ctx.apps.onChange(() => {
      if (!local) return;
      if (ctx.apps.running()) { backoffSec = 0; retryAt = 0; return; }
      if (sock) dropSocket(sock, "OBS закрыт");
      notRunning = true;
      rec = stream = stats = null; micMuted = null; bitKbps = null; fps = null;
      for (const id of ["obs", "fps", "stats", "mic"]) dropCard(id);
    });

    ctx.poll(async () => {
      if (!up) {
        if (Date.now() < retryAt) {
          if (notRunning) return idleText();
          throw new Error(lastErr || "OBS: нет соединения");
        }
        try {
          await connect();
          notRunning = false;
          await probe();
          rec = stream = stats = null;
          micMuted = null; micDb = null; bitKbps = null; bitPrev = null; tallyKey = ""; tallyAt = 0;
        } catch (e) {
          lastErr = String((e && e.message) || e);
          backoffSec = Math.min(BACKOFF_MAX_SEC, backoffSec ? backoffSec * 2 : 2);
          retryAt = Date.now() + backoffSec * 1000;
          rec = stream = stats = null; micMuted = null; bitKbps = null; fps = null;
          // Без Hello при ЗАПУЩЕННОМ OBS — это не «не запущен», а выключенный сервер.
          notRunning = !!(e && e.notRunning) && (!local || !obsRunning());
          if (e && e.notRunning && !notRunning)
            lastErr = "OBS запущен, но не отвечает: включите Tools → WebSocket Server Settings → Enable WebSocket Server";
          if (notRunning) {
            // Нечего показывать: карточки уходят, место на панели достаётся остальным.
            for (const id of ["obs", "fps", "stats", "mic"]) dropCard(id);
            return idleText();
          }
          renderOffline();
          throw new Error(lastErr);
        }
      }

      if (wantMic && ctx.cards.placed().indexOf("mic") >= 0) micCheck();
      const needMic = wantMic && !micMissing && ctx.cards.placed().indexOf("mic") >= 0 && !!micName;

      // Каждый тик — только то, что живёт на экране. Запросы идут параллельно,
      // а метка времени at фиксируется прямо по приходу ответа OBS — чтобы задержка
      // одного запроса не сдвигала таймер эфира в elapsed (D-108).
      const got = await Promise.all([
        sendRequest("GetStats").catch(() => null),
        hasRequest("GetRecordStatus")
          ? sendRequest("GetRecordStatus").then(r => ({ r, at: Date.now() })).catch(() => null)
          : Promise.resolve(null),
        hasRequest("GetStreamStatus")
          ? sendRequest("GetStreamStatus").then(r => ({ r, at: Date.now() })).catch(() => null)
          : Promise.resolve(null),
        hasRequest("GetCurrentProgramScene") ? sendRequest("GetCurrentProgramScene").catch(() => null) : Promise.resolve(null),
        needMic && hasRequest("GetInputMute") ? sendRequest("GetInputMute", { inputName: micName }).catch(() => null) : Promise.resolve(null),
        needMic && hasRequest("GetInputVolume") ? sendRequest("GetInputVolume", { inputName: micName }).catch(() => null) : Promise.resolve(null),
      ]);
      const st = got[0], recItem = got[1], strItem = got[2], scR = got[3], m = got[4], vol = got[5];
      if (st === null && recItem === null && strItem === null && scR === null) {
        dropSocket(sock, "запросы не проходят");
        throw new Error("OBS: соединение есть, а ответов нет");
      }

      if (st) stats = st;
      if (recItem && recItem.r) {
        const recR = recItem.r;
        rec = { active: !!recR.outputActive, paused: !!recR.outputPaused,
                reconnecting: false, ms: Number(recR.outputDuration) || 0, at: recItem.at };
      }
      if (strItem && strItem.r) {
        const strR = strItem.r;
        stream = { active: !!strR.outputActive, paused: false, reconnecting: !!strR.outputReconnecting,
                   congestion: Number.isFinite(Number(strR.outputCongestion)) ? Number(strR.outputCongestion) : null,
                   ms: Number(strR.outputDuration) || 0, at: strItem.at };
        // Битрейт — дельта счётчика отправленных байт: самого битрейта в GetStreamStatus нет.
        const bytes = Number(strR.outputBytes);
        const on = stream.active && Number.isFinite(bytes);
        if (on && bitPrev !== null && Date.now() > bitPrev.at && bytes >= bitPrev.bytes) {
          const inst = ((bytes - bitPrev.bytes) * 8) / 1000 / ((Date.now() - bitPrev.at) / 1000);   // кбит/с
          bitKbps = bitKbps === null ? inst : bitKbps * 0.6 + inst * 0.4;
        }
        bitPrev = on ? { bytes, at: strItem.at } : null;
        if (!stream.active) bitKbps = null;
      }
      if (scR && scR.sceneName) scene = String(scR.sceneName);
      if (st && Number.isFinite(Number(st.activeFps))) fps = Number(st.activeFps);
      tallyFlip();
      render(true);
      renderStats();

      if (needMic) {
        if (m && m.inputMuted !== undefined) micMuted = !!m.inputMuted;
        if (vol && Number.isFinite(Number(vol.inputVolumeDb))) micDb = Number(vol.inputVolumeDb);
      }
      renderMic(true);

      // Кривая кадров нужна только когда карточка в раскладке: точка ряда — это
      // значение, и копить ряд ради карточки, которую никто не смотрит, незачем.
      if (fps !== null && ctx.cards.placed().indexOf("fps") >= 0) renderFps();
      else dropCard("fps");

      const recOn = !!(rec && rec.active), liveOn = !!(stream && stream.active);
      return "OBS · " + (recOn ? "REC " + clock(elapsed(rec)) : liveOn ? "LIVE " + clock(elapsed(stream)) : "ожидание") +
        (scene ? " · " + scene : "") + (fpsTarget ? " · цель " + fixed(fpsTarget, 0) + " к/с" : "");
    }, { everySec: POLL_SEC, whileApp: local });
  },
});
