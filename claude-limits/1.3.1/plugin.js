// Лимиты Claude Code для Usee — 5-часовая сессия и недельный лимит одной
// карточкой meters: бары «Сессия/Неделя» + футер «СБРОС …» (про 5ч-сессию, а
// если недельная у порога — про неё).
//
// ВАЖНО про источник данных: реальные проценты плана (used_percentage) и время
// сброса (resets_at) есть ТОЛЬКО в stdin statusline-хука Claude Code — их нет в
// логах, ccusage их не отдаёт. Поэтому нужен разовый «мост»: пользователь
// добавляет несколько строк в свой statusline, и тот дампит rate_limits в файл
// usee-limits.json в папке .claude (см. README). Плагин НЕ читает произвольное:
// он вызывает ОБЪЯВЛЕННУЮ в манифесте команду «read» (findstr) и передаёт лишь
// имя файла; хост проверяет, что путь остаётся под настройкой claudeDir.

const FILE = "usee-limits.json";
const pad2 = (n) => (n < 10 ? "0" : "") + n;

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
  return h ? h + "ч " + pad2(m) + "м" : m + "м";
}

// % окна с обнулением после сброса (прошло → новое окно, 0%).
function pctOf(win, now) {
  if (typeof win?.used_percentage !== "number") return null;
  const reset = Number(win.resets_at) || 0;
  const p = reset && now >= reset ? 0 : win.used_percentage;
  return Math.max(0, Math.min(100, Math.round(p)));
}

definePlugin({
  cards: {
    limits: { label: "Лимиты Claude", type: "meters",
              fields: { number: { label: "Сессия %", kind: "number" } } },
  },

  activate(ctx) {
    const mode = ctx.settings.get("cards");               // both | session | week
    const weekFooterAt = ctx.settings.get("weekFooterAt");

    ctx.poll(async () => {
      const r = await ctx.exec.run("read", { file: FILE });
      const out = String(r.stdout || "").trim();
      if (r.code !== 0 || !out) {                           // findstr 1 = файла нет или он пуст
        ctx.status.set("warn", `нет данных — statusline не пишет ${FILE}? (см. README)`);
        return;
      }
      let data;
      try { data = JSON.parse(out); } catch (e) { throw new Error("битый " + FILE); }
      const rl = data.rate_limits ?? {};
      const now = Date.now() / 1000;
      const s = rl.five_hour, w = rl.seven_day;
      const sPct = pctOf(s, now), wPct = pctOf(w, now);

      // label — короткая форма для узких карточек, label16 — для 264 px. Заголовок
      // карточки не задаём: он стоит СТРОКИ на 129×109 и дублировал бы label16.
      const rows = [];
      if (mode !== "week" && sPct !== null) rows.push({ label: "Сессия", label16: "Claude · сессия", pct: sPct });
      if (mode !== "session" && wPct !== null) rows.push({ label: "Неделя", label16: "Claude · неделя", pct: wPct });
      if (!rows.length) {
        ctx.cards.limits.remove();
        ctx.status.set("warn", `нет данных — statusline не пишет ${FILE}?`);
        return;
      }

      const sReset = Number(s?.resets_at) || 0, wReset = Number(w?.resets_at) || 0;
      const weekHot = wPct !== null && wPct >= weekFooterAt;
      let footer = "";
      if (mode === "week") footer = wReset ? "СБРОС " + fmtDH(wReset - now) : "";
      else if (weekHot && wReset && mode === "both") footer = "СБРОС " + fmtDH(wReset - now);  // неделя у порога
      else if (sReset) footer = "СБРОС " + fmtHMM(sReset - now);                              // ждём 5ч-сброс
      else if (wReset) footer = "СБРОС " + fmtDH(wReset - now);

      ctx.cards.limits.set({ rows, footer, number: sPct ?? wPct ?? 0 },
                           { width: "flex", minW: 3 });      // место под подпись, бар и %
      return `сессия ${sPct ?? "—"}% · неделя ${wPct ?? "—"}%`;
    }, { everySetting: "intervalSec" });
  },
});
