// Docker для Usee — статус демона и контейнеры (CPU/RAM) на дисплее.
//
// Транспорт: Docker Engine API — это HTTP/1.1. На Windows/Docker Desktop он
// торчит именованным пайпом \\.\pipe\docker_engine, до которого дотягивается
// ctx.pipe (sdk 3). ctx.net.fetch тут не годится (он только TCP), поэтому ниже
// маленький ПЕРЕИСПОЛЬЗУЕМЫЙ HTTP-over-stream шим: сам форматируем запрос и
// парсим ответ (content-length / chunked). Он не docker-специфичен — тот же код
// работает поверх любого байтового потока с HTTP на том конце.
//
// Упрощение: на каждый запрос открываем НОВЫЙ пайп и шлём «Connection: close» —
// демон отвечает и закрывает соединение, мы собираем весь ответ на close и
// парсим разом (без инкрементального разбора и keep-alive). Опрос раз в N сек.
//
// Если задан TCP-адрес демона (настройка endpoint, напр. 127.0.0.1:2375) —
// используем обычный ctx.net.fetch, минуя пайп (для тех, у кого включён
// незащищённый TCP-эндпоинт).

const PIPE_NAME = "docker_engine";
const REQ_TIMEOUT_MS = 4000;
const DEFAULT_INTERVAL_SEC = 5;

// ---- HTTP-over-stream шим (переиспользуемый) --------------------------------

function strBytes(s) {                       // ASCII-запрос → массив байт
  const a = [];
  for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xFF);
  return a;
}

function utf8(b) {                           // байты → строка (UTF-8, TextDecoder в песочнице нет)
  let s = "", i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xE0) s += String.fromCharCode(((c & 0x1F) << 6) | (b[i++] & 0x3F));
    else if (c < 0xF0) {
      const c2 = b[i++], c3 = b[i++];
      s += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F));
    } else {
      const c2 = b[i++], c3 = b[i++], c4 = b[i++];
      let cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F);
      cp -= 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return s;
}

function sub(b, start, end) {                // срез массива байт в новый массив
  if (end == null || end > b.length) end = b.length;
  const out = [];
  for (let i = start; i < end; i++) out.push(b[i]);
  return out;
}

// Разбор HTTP-ответа из полного буфера байт → { status, text }.
function parseHttp(b) {
  let hEnd = -1;
  for (let i = 0; i + 3 < b.length; i++)
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) { hEnd = i; break; }
  if (hEnd < 0) throw "ответ без заголовков";

  let head = "";
  for (let i = 0; i < hEnd; i++) head += String.fromCharCode(b[i]);
  const lines = head.split("\r\n");
  const status = parseInt((lines[0].split(" ")[1]) || "0", 10) || 0;

  let chunked = false, contentLen = -1;
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    const k = lines[i].slice(0, idx).trim().toLowerCase();
    const v = lines[i].slice(idx + 1).trim();
    if (k === "transfer-encoding" && v.toLowerCase().indexOf("chunked") >= 0) chunked = true;
    else if (k === "content-length") contentLen = parseInt(v, 10);
  }

  const start = hEnd + 4;
  let body;
  if (chunked) body = dechunk(b, start);
  else if (contentLen >= 0) body = sub(b, start, start + contentLen);
  else body = sub(b, start);                 // close-delimited
  return { status: status, text: utf8(body) };
}

function dechunk(b, pos) {
  const out = [];
  while (pos < b.length) {
    let line = "";
    while (pos + 1 < b.length && !(b[pos] === 13 && b[pos + 1] === 10)) { line += String.fromCharCode(b[pos]); pos++; }
    pos += 2;                                // \r\n после размера
    const size = parseInt(line.trim(), 16);
    if (!(size > 0)) break;                  // 0-чанк = конец
    for (let i = 0; i < size && pos < b.length; i++) out.push(b[pos++]);
    pos += 2;                                // \r\n после данных чанка
  }
  return out;
}

// Один HTTP GET по пайпу: открыть → запрос с Connection: close → собрать ответ
// на close → распарсить. Возвращает Promise<распарсенный JSON>.
function pipeGet(ctx, path) {
  return new Promise((resolve, reject) => {
    let pipe;
    try { pipe = ctx.pipe.connect(PIPE_NAME); }
    catch (e) { reject("нет пайпа docker_engine (Docker запущен?): " + e); return; }

    const buf = [];
    let done = false;
    const to = ctx.timers.setTimeout(() => finish("таймаут ответа демона"), REQ_TIMEOUT_MS);

    function finish(err) {
      if (done) return; done = true;
      ctx.timers.clear(to);
      try { pipe.close(); } catch (e) {}
      if (err) { reject(err); return; }
      try {
        const res = parseHttp(buf);
        if (res.status < 200 || res.status >= 300) { reject("HTTP " + res.status); return; }
        resolve(JSON.parse(res.text));
      } catch (e) { reject("разбор ответа: " + e); }
    }

    pipe.on("data", ch => { for (let i = 0; i < ch.length; i++) buf.push(ch[i]); });
    pipe.on("close", () => finish(buf.length ? null : "пустой ответ"));

    const req = "GET " + path + " HTTP/1.1\r\nHost: localhost\r\n" +
                "Accept: application/json\r\nConnection: close\r\n\r\n";
    try { pipe.write(strBytes(req)); }
    catch (e) { finish("запись в пайп: " + e); }
  });
}

// GET к демону: пайп по умолчанию, либо обычный fetch если задан TCP-endpoint.
function dockerGet(ctx, path) {
  const ep = String(ctx.settings.get("endpoint") || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (ep) {
    return ctx.net.fetch("http://" + ep + path).then(r => {
      if (!r.ok) throw "HTTP " + r.status;
      return r.json();
    });
  }
  return pipeGet(ctx, path);
}

// ---- разбор данных Docker ----------------------------------------------------

function shortName(c) {
  let n = (c.Names && c.Names[0]) || c.Image || c.Id || "?";
  n = String(n).replace(/^\//, "");
  return n.length > 16 ? n.slice(0, 15) + "…" : n;
}

function cpuPct(s) {
  const cpu = s && s.cpu_stats, pre = s && s.precpu_stats;
  if (!cpu || !pre || !cpu.cpu_usage || !pre.cpu_usage) return 0;
  const cd = (cpu.cpu_usage.total_usage || 0) - (pre.cpu_usage.total_usage || 0);
  const sd = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const cores = cpu.online_cpus ||
    (cpu.cpu_usage.percpu_usage ? cpu.cpu_usage.percpu_usage.length : 1) || 1;
  return (sd > 0 && cd > 0) ? (cd / sd) * cores * 100 : 0;
}

function memPct(s) {
  const m = s && s.memory_stats;
  if (!m || !m.limit) return 0;
  let used = m.usage || 0;
  if (m.stats && m.stats.cache) used -= m.stats.cache;   // Docker вычитает cache из «used»
  return used > 0 ? (used / m.limit) * 100 : 0;
}

function clampPct(v) { return Math.max(0, Math.min(100, Math.round(v))); }

// ---- иконка (процедурная, RGB565) -------------------------------------------

const ICON = 24;
function rgb565(r, g, b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
const IC_BG = rgb565(0x23, 0x27, 0x2E);      // плитка устройства
const IC_BLUE = rgb565(0x24, 0x96, 0xED);    // docker-синий
const IC_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function icB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const h1 = i + 1 < bytes.length, h2 = i + 2 < bytes.length;
    const b0 = bytes[i] & 0xFF, b1 = h1 ? bytes[i + 1] & 0xFF : 0, b2 = h2 ? bytes[i + 2] & 0xFF : 0;
    out += IC_B64[b0 >> 2] + IC_B64[((b0 & 3) << 4) | (b1 >> 4)] +
           (h1 ? IC_B64[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
           (h2 ? IC_B64[b2 & 63] : "=");
  }
  return out;
}
function dockerIcon() {
  const px = new Array(ICON * ICON);
  for (let i = 0; i < px.length; i++) px[i] = IC_BG;
  function rect(x0, y0, w, h, c) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xx = x0 + x, yy = y0 + y;
      if (xx >= 0 && xx < ICON && yy >= 0 && yy < ICON) px[yy * ICON + xx] = c;
    }
  }
  // сетка «контейнеров» как в логотипе: нижний ряд 3, верхний 2 + база-корпус
  const s = 4, g = 1;
  const cols = [5, 5 + s + g, 5 + 2 * (s + g)];
  for (let k = 0; k < cols.length; k++) rect(cols[k], 11, s, s, IC_BLUE);    // нижний ряд ×3
  rect(cols[0], 6, s, s, IC_BLUE);                                           // верхний ряд ×2
  rect(cols[1], 6, s, s, IC_BLUE);
  rect(4, 16, ICON - 8, 2, IC_BLUE);                                         // «палуба»
  const bytes = new Array(px.length * 2);
  for (let i = 0; i < px.length; i++) { bytes[i * 2] = px[i] & 0xFF; bytes[i * 2 + 1] = (px[i] >> 8) & 0xFF; }
  return ICON + "x" + ICON + "," + icB64(bytes);
}

// ---- плагин ------------------------------------------------------------------

definePlugin({
  activate(ctx) {
    let pollTimer = -1;
    let polling = false;      // не запускать новый опрос, пока идёт прошлый (пайп ≤2)

    const cardMode = () => String(ctx.settings.get("card") || "both");
    const metric   = () => String(ctx.settings.get("metric") || "cpu");
    const labelText = () => String(ctx.settings.get("label") || "Docker").toUpperCase();

    function intervalMs() {
      const n = Number(ctx.settings.get("intervalSec"));
      return (isFinite(n) && n >= 2 && n <= 300 ? n : DEFAULT_INTERVAL_SEC) * 1000;
    }
    function staleSec() { return Math.max(Math.round(intervalMs() / 1000) * 3, 20); }

    function widthOpts(o) {
      const w = ctx.settings.get("width");
      if (w === "fixed" || w === "flex") {
        o.width = w;
        const mn = Number(ctx.settings.get("minW")); if (isFinite(mn)) o.minW = Math.min(6, Math.max(2, mn | 0));
        const mx = Number(ctx.settings.get("maxW")); if (isFinite(mx)) o.maxW = Math.min(6, Math.max(2, mx | 0));
      }
      return o;
    }

    function declare() {
      const mode = cardMode();
      const list = [];
      if (mode !== "meters") list.push({ id: "docker", label: "Docker · статус", type: "status" });
      if (mode !== "status") list.push({ id: "stats", label: "Docker · контейнеры", type: "meters" });
      ctx.cards.declare(list);
    }

    // Последовательный сбор stats (пайп ≤2 — не паримся, идём по одному).
    function collectStats(running) {
      const out = [];
      let p = Promise.resolve();
      running.forEach(c => {
        p = p.then(() => dockerGet(ctx, "/containers/" + c.Id + "/stats?stream=false"))
             .then(s => out.push({ name: shortName(c), cpu: cpuPct(s), mem: memPct(s) }))
             .catch(() => out.push({ name: shortName(c), cpu: 0, mem: 0 }));
      });
      return p.then(() => out);
    }

    function renderStatus(running, total, up) {
      if (cardMode() === "meters") { ctx.cards.remove("docker"); return; }
      const p = {
        type: "status",
        icon: "dk",
        line1: labelText(),
        line2: up ? (running + " / " + total + " контейнеров") : "демон недоступен",
        badge: up ? String(running) : "—",
        badgeKind: up && running > 0 ? "accent" : "plain",
        state: up ? "up" : "down",
        is_on: up,
      };
      ctx.cards.upsert("docker", p, widthOpts({ band: 4, order: 1, stalenessSec: staleSec() }));
    }

    function renderStats(rows) {
      if (cardMode() === "status") { ctx.cards.remove("stats"); return; }
      const useMem = metric() === "mem";
      const sorted = rows.slice().sort((a, b) => (useMem ? b.mem - a.mem : b.cpu - a.cpu));
      const top = sorted.slice(0, 4).map(r => ({
        label: r.name, pct: clampPct(useMem ? r.mem : r.cpu),
      }));
      const p = {
        type: "meters",
        title: "КОНТЕЙНЕРЫ · " + (useMem ? "RAM %" : "CPU %"),
        rows: top.length ? top : [{ label: "нет запущенных", pct: 0 }],
      };
      ctx.cards.upsert("stats", p, widthOpts({ band: 4, order: 2, stalenessSec: staleSec() }));
    }

    function poll() {
      if (polling) return;                          // прошлый опрос ещё идёт → пропускаем тик
      polling = true;
      dockerGet(ctx, "/containers/json?all=1")
        .then(list => {
          const all = Array.isArray(list) ? list : [];
          const running = all.filter(c => c && c.State === "running");
          renderStatus(running.length, all.length, true);
          ctx.status.set("ok", "Docker · " + running.length + "/" + all.length + " контейнеров");

          if (cardMode() === "status") return;      // без мини-баров stats не тянем
          return collectStats(running).then(renderStats);
        })
        .catch(e => {
          ctx.log.warn("docker: " + e);
          ctx.status.set("error", String(e));
          renderStatus(0, 0, false);
          ctx.cards.remove("stats");
        })
        .then(() => { polling = false; }, () => { polling = false; });
    }

    function reschedule() {
      if (pollTimer !== -1) ctx.timers.clear(pollTimer);
      pollTimer = ctx.timers.setInterval(poll, intervalMs());
    }

    ctx.cards.icon("dk", dockerIcon());
    declare();
    poll();
    reschedule();

    ctx.settings.onChange(() => { declare(); poll(); reschedule(); });
  },

  deactivate() {
    // пайпы и таймеры хост закрывает сам
  },
});
