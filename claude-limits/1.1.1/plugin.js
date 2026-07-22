// Лимиты Claude Code для Usee — 5-часовая сессия и недельный лимит на дисплее
// одной карточкой meters: бары СЕС/НЕД + футер «СБРОС …» (про 5ч-сессию, а если
// недельная заполнена — про неё).
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

function pad2(n) { return (n < 10 ? "0" : "") + n; }

// сессия (5ч-окно): «H:MM» до сброса — «2:14»
function fmtHMM(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 3600) + ":" + pad2(Math.floor((sec % 3600) / 60));
}
// неделя (7д-окно): «Xд Yч» / «Xч Yм»
function fmtDH(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d >= 1) return d + "д " + h + "ч";
  return h ? (h + "ч " + pad2(m) + "м") : (m + "м");
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
        o.width = "flex"; o.minW = 3;   // место под label+бар+% в строке
      }
      if (o.height === undefined) o.height = 4;   // kit: METERS · M · 3×4 (title + 2 строки + футер)
      return o;
    }

    function declare() {
      ctx.cards.declare([{ id: "limits", label: "Лимиты Claude", type: "meters",
        fields: { "number": { label: "Сессия %", kind: "number" } } }]);
    }

    // % окна с обнулением после сброса (прошло → новое окно, 0%).
    function pctOf(win, now) {
      if (!win || typeof win.used_percentage !== "number") return null;
      let p = win.used_percentage;
      const r = Number(win.resets_at) || 0;
      if (r && now >= r) p = 0;
      return Math.max(0, Math.min(100, Math.round(p)));
    }

    // Одна meters-карточка: бары СЕС/НЕД + футер «СБРОС …». Футер про 5ч-сессию,
    // а если недельная заполнена (100%) — про неё (сброс недельной важнее).
    function apply(data) {
      const rl = (data && data.rate_limits) || {};
      const now = Date.now() / 1000;
      const s = rl.five_hour, w = rl.seven_day;
      const m = mode();
      const sPct = pctOf(s, now), wPct = pctOf(w, now);

      const rows = [];
      if (m !== "week" && sPct !== null)    rows.push({ label: "Сес.", pct: sPct });
      if (m !== "session" && wPct !== null) rows.push({ label: "Нед.", pct: wPct });
      if (rows.length === 0) { ctx.status.set("warn", "нет данных — statusline не пишет " + FILE + "?"); ctx.cards.remove("limits"); return; }

      const sReset = Number(s && s.resets_at) || 0, wReset = Number(w && w.resets_at) || 0;
      const weekFull = wPct !== null && wPct >= 100;
      let footer = "";
      if (m === "week")                            footer = wReset ? "СБРОС " + fmtDH(wReset - now) : "";
      else if (weekFull && wReset && m === "both") footer = "СБРОС " + fmtDH(wReset - now);   // упёрлись в недельный
      else if (sReset && m !== "week")             footer = "СБРОС " + fmtHMM(sReset - now);  // ждём 5ч-сброс
      else if (wReset)                             footer = "СБРОС " + fmtDH(wReset - now);

      ctx.cards.upsert("limits", {
        type: "meters", title: "CLAUDE", rows: rows, footer: footer,
        number: sPct !== null ? sPct : (wPct || 0),
      }, widthOpts({ band: 4, order: 1, stalenessSec: staleSec() }));

      const sp = sPct !== null ? sPct + "%" : "—", wp = wPct !== null ? wPct + "%" : "—";
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

    declare();
    poll();
    reschedule();
    ctx.settings.onChange(() => { declare(); poll(); reschedule(); });
  },

  deactivate() {
    // таймеры хост закрывает сам
  },
});
