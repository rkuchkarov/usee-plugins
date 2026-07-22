// Лимиты Claude Code для Usee — процент 5-часовой сессии и недельный лимит на
// дисплее (карточки status: % + время до сброса).
//
// ВАЖНО про источник данных: реальные проценты плана (used_percentage) и время
// сброса (resets_at) существуют ТОЛЬКО в stdin statusline-хука Claude Code — их
// нет в логах, ccusage их не отдаёт. Поэтому нужен разовый «мост»: пользователь
// добавляет несколько строк в свой statusline, который дампит rate_limits в файл
// «usee-limits.json» внутри папки .claude (см. README). Плагин НЕ читает
// произвольное — он вызывает ЗАДЕКЛАРИРОВАННУЮ в манифесте команду «read»
// (findstr) и передаёт лишь имя файла; хост валидирует, что путь остаётся под
// настройкой claudeDir. Пользователь видел эту команду на экране разрешений.

const DEFAULT_INTERVAL_SEC = 30;
const FILE = "usee-limits.json";

// ---- иконка (процедурная, RGB565): «искра» Claude -----------------------------
const IC = 24;
function rgb565(r, g, b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
const IC_BG = rgb565(0x23, 0x27, 0x2E);
const IC_AC = rgb565(0xD9, 0x77, 0x57);   // Claude coral
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function icB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const h1 = i + 1 < bytes.length, h2 = i + 2 < bytes.length;
    const b0 = bytes[i] & 0xFF, b1 = h1 ? bytes[i + 1] & 0xFF : 0, b2 = h2 ? bytes[i + 2] & 0xFF : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] +
           (h1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=") + (h2 ? B64[b2 & 63] : "=");
  }
  return out;
}
function claudeIcon() {
  const px = new Array(IC * IC).fill(IC_BG);
  const cx = 12, cy = 12;
  function set(x, y, c) { if (x >= 0 && x < IC && y >= 0 && y < IC) px[y * IC + x] = c; }
  function line(x0, y0, x1, y1, c) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    for (;;) {
      set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  // восьмилучевая искра
  const rays = [[0, -8], [8, 0], [0, 8], [-8, 0], [6, -6], [6, 6], [-6, 6], [-6, -6]];
  for (const [dx, dy] of rays) line(cx, cy, cx + dx, cy + dy, IC_AC);
  const bytes = new Array(px.length * 2);
  for (let i = 0; i < px.length; i++) { bytes[i * 2] = px[i] & 0xFF; bytes[i * 2 + 1] = (px[i] >> 8) & 0xFF; }
  return IC + "x" + IC + "," + icB64(bytes);
}

// ---- компактно «Xд Yч» / «Xч YYм» / «Xм» (узкая status-карточка) ---------------
function fmtLeft(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d >= 1) return d + "д" + h + "ч";
  return h ? (h + "ч" + (m < 10 ? "0" : "") + m + "м") : (m + "м");
}

definePlugin({
  activate(ctx) {
    let timer = -1;
    let polling = false;

    const dirOf = () => String(ctx.settings.get("claudeDir") || "").trim();
    const mode = () => String(ctx.settings.get("cards") || "both");

    function intervalMs() {
      const n = Number(ctx.settings.get("intervalSec"));
      return (isFinite(n) && n >= 10 && n <= 300 ? n : DEFAULT_INTERVAL_SEC) * 1000;
    }
    function staleSec() { return Math.max(Math.round(intervalMs() / 1000) * 3, 90); }

    function widthOpts(o) {
      const w = ctx.settings.get("width");
      if (w === "fixed" || w === "flex") {
        o.width = w;
        const mn = Number(ctx.settings.get("minW")); if (isFinite(mn)) o.minW = Math.min(6, Math.max(2, mn | 0));
        const mx = Number(ctx.settings.get("maxW")); if (isFinite(mx)) o.maxW = Math.min(6, Math.max(2, mx | 0));
      } else {
        o.width = "flex"; o.minW = 4;   // авто: под «↻ 3ч12м (в 21:30)» нужно ≥4 клетки
      }
      return o;
    }

    function declare() {
      const m = mode();
      const list = [];
      if (m !== "week")    list.push({ id: "session", label: "Сессия Claude", type: "status", fields: { "number": { label: "Сессия %", kind: "number" } } });
      if (m !== "session") list.push({ id: "week", label: "Неделя Claude", type: "status", fields: { "number": { label: "Неделя %", kind: "number" } } });
      ctx.cards.declare(list);
    }

    // Одна карточка лимита: % (line1), время до сброса (line2), метка-бейдж с
    // цветом по уровню; процент — на шину (number) для условий/HA.
    function renderLimit(id, label, win, now, order) {
      if (!win || typeof win.used_percentage !== "number") { ctx.cards.remove(id); return; }
      let pct = win.used_percentage;
      const reset = Number(win.resets_at) || 0;
      let line2;
      if (reset && now >= reset) { pct = 0; line2 = "окно сброшено"; }        // прошло → новое окно, 0%
      else if (reset) {
        const dt = new Date(reset * 1000);                                    // локальное время сброса
        const hh = dt.getHours(), mm = dt.getMinutes();
        const clock = (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
        line2 = "↻ " + fmtLeft(reset - now) + " (в " + clock + ")";           // ↻ 3ч12м (в 21:30)
      } else line2 = "";
      pct = Math.max(0, Math.min(100, Math.round(pct)));
      const kind = pct >= 90 ? "critical" : pct >= 75 ? "warn" : "accent";
      ctx.cards.upsert(id, {
        type: "status", icon: "claude",
        line1: pct + "%",
        line2: line2,
        badge: label, badgeKind: kind,
        state: pct + "%",
        number: pct,
      }, widthOpts({ band: 4, order: order, stalenessSec: staleSec() }));
    }

    function apply(data) {
      const rl = (data && data.rate_limits) || {};
      const now = Date.now() / 1000;
      const m = mode();
      if (m !== "week") renderLimit("session", "СЕССИЯ", rl.five_hour, now, 1); else ctx.cards.remove("session");
      if (m !== "session") renderLimit("week", "НЕДЕЛЯ", rl.seven_day, now, 2); else ctx.cards.remove("week");

      const s = rl.five_hour, w = rl.seven_day;
      const sp = s && typeof s.used_percentage === "number" ? Math.round(s.used_percentage) + "%" : "—";
      const wp = w && typeof w.used_percentage === "number" ? Math.round(w.used_percentage) + "%" : "—";
      ctx.status.set("ok", "сессия " + sp + " · неделя " + wp);
    }

    function poll() {
      if (polling) return;
      const dir = dirOf();
      if (!dir) { ctx.status.set("warn", "укажите папку .claude"); return; }
      polling = true;

      ctx.exec.run("read", { file: FILE })
        .then(r => {
          const out = String(r.stdout || "").trim();
          if (r.code !== 0 || !out) {
            // findstr code 1 = файла нет / он пуст → statusline ещё не писал
            ctx.status.set("warn", "нет данных — statusline не пишет " + FILE + "? (см. README)");
            return;
          }
          let data;
          try { data = JSON.parse(out); }
          catch (e) { ctx.status.set("error", "битый " + FILE); return; }
          apply(data);
        })
        .catch(e => { ctx.log.warn("claude-limits: " + e); ctx.status.set("error", String(e)); })
        .then(() => { polling = false; }, () => { polling = false; });
    }

    function reschedule() {
      if (timer !== -1) ctx.timers.clear(timer);
      timer = ctx.timers.setInterval(poll, intervalMs());
    }

    ctx.cards.icon("claude", claudeIcon());
    declare();
    poll();
    reschedule();
    ctx.settings.onChange(() => { declare(); poll(); reschedule(); });
  },

  deactivate() {
    // таймеры хост закрывает сам
  },
});
