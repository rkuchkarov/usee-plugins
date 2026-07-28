// Git для Usee — ветка и незакоммиченные изменения указанной папки на дисплее.
//
// Демонстрация ctx.exec (SDK 5): git-состояние живёт в файлах + CLI, к которым у
// песочницы нет доступа. Плагин НЕ запускает произвольное — он вызывает
// ЗАДЕКЛАРИРОВАННЫЕ в манифесте команды («branch», «diffstat») и передаёт лишь
// значение дырки {repo} (валидируется хостом: путь остаётся под настройкой
// repoPath). Пользователь видел эти команды на экране разрешений при установке.
//
// Карточки: status «ветка» (+добавлено/−удалено, число файлов, ветка в line1),
// meters «файлы» (топ-4 по изменённым строкам). Число изменённых файлов уходит
// на шину значений (number) — для условий/HA.

const DEFAULT_INTERVAL_SEC = 10;

function repoOf(ctx) { return String(ctx.settings.get("repoPath") || "").trim(); }

// Разбор `git diff --numstat HEAD`: строки "added\tremoved\tpath" (бинарники — "-").
function parseNumstat(out) {
  let added = 0, removed = 0, files = 0;
  const perFile = [];
  String(out || "").split("\n").forEach(line => {
    const t = line.split("\t");
    if (t.length < 3) return;
    const a = t[0] === "-" ? 0 : (parseInt(t[0], 10) || 0);
    const r = t[1] === "-" ? 0 : (parseInt(t[1], 10) || 0);
    const path = t.slice(2).join("\t").trim();
    if (!path) return;
    added += a; removed += r; files++;
    perFile.push({ path: path, lines: a + r });
  });
  return { added: added, removed: removed, files: files, perFile: perFile };
}

function baseName(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  const n = parts[parts.length - 1] || p;
  return n.length > 16 ? n.slice(0, 15) + "…" : n;
}

// ---- иконка (процедурная, RGB565): граф-ветка git ----------------------------

const ICON = 24;
function rgb565(r, g, b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
const IC_BG = rgb565(0x23, 0x27, 0x2E);
const IC_GIT = rgb565(0x9A, 0xA0, 0xAB);     // серый (обозначение ветки)
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
// Смешать два RGB565 по коэффициенту a (0..1) — для сглаживания краёв.
function mix565(bg, fg, a) {
  if (a <= 0) return bg;
  if (a >= 1) return fg;
  const br = (bg >> 11) & 0x1F, bgc = (bg >> 5) & 0x3F, bb = bg & 0x1F;
  const fr = (fg >> 11) & 0x1F, fgc = (fg >> 5) & 0x3F, fb = fg & 0x1F;
  return ((Math.round(br + (fr - br) * a) & 0x1F) << 11) |
         ((Math.round(bgc + (fgc - bgc) * a) & 0x3F) << 5) |
          (Math.round(bb + (fb - bb) * a) & 0x1F);
}
function gitIcon() {
  const px = new Array(ICON * ICON);
  for (let i = 0; i < px.length; i++) px[i] = IC_BG;
  // Кладём цвет c поверх фона с покрытием a (антиалиас: доля пикселя внутри фигуры).
  function blend(x, y, c, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= ICON || y < 0 || y >= ICON || a <= 0) return;
    const i = y * ICON + x;
    px[i] = mix565(px[i], c, a > 1 ? 1 : a);
  }
  // Круглая точка радиуса r со сглаженным краем (~1px).
  function disc(cx, cy, r, c) {
    const r0 = Math.ceil(r + 1);
    for (let y = -r0; y <= r0; y++) for (let x = -r0; x <= r0; x++) {
      const a = r + 0.5 - Math.sqrt(x * x + y * y);
      if (a > 0) blend(cx + x, cy + y, c, a);
    }
  }
  // Толстая линия ширины w со сглаженными краями и скруглёнными концами
  // (покрытие = расстояние пикселя до отрезка).
  function line(x0, y0, x1, y1, w, c) {
    const half = w / 2;
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    const minX = Math.floor(Math.min(x0, x1) - half - 1), maxX = Math.ceil(Math.max(x0, x1) + half + 1);
    const minY = Math.floor(Math.min(y0, y1) - half - 1), maxY = Math.ceil(Math.max(y0, y1) + half + 1);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      let t = ((x - x0) * dx + (y - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px2 = x0 + t * dx, py2 = y0 + t * dy;
      const a = half + 0.5 - Math.sqrt((x - px2) * (x - px2) + (y - py2) * (y - py2));
      if (a > 0) blend(x, y, c, a);
    }
  }
  line(8, 6, 8, 18, 2, IC_GIT);                // основная ветка
  line(8, 12, 16, 7, 2, IC_GIT);               // ответвление
  disc(8, 6, 2.6, IC_GIT);                     // коммиты (круглые точки)
  disc(8, 18, 2.6, IC_GIT);
  disc(16, 7, 2.6, IC_GIT);                    // коммит на ветке
  const bytes = new Array(px.length * 2);
  for (let i = 0; i < px.length; i++) { bytes[i * 2] = px[i] & 0xFF; bytes[i * 2 + 1] = (px[i] >> 8) & 0xFF; }
  return ICON + "x" + ICON + "," + icB64(bytes);
}

// ---- плагин ------------------------------------------------------------------

definePlugin({
  activate(ctx) {
    let pollTimer = -1;
    let polling = false;

    const cardMode = () => String(ctx.settings.get("card") || "both");
    const labelOf = (branch) => String(ctx.settings.get("label") || branch || "Git").toUpperCase();

    function intervalMs() {
      const n = Number(ctx.settings.get("intervalSec"));
      return (isFinite(n) && n >= 2 && n <= 300 ? n : DEFAULT_INTERVAL_SEC) * 1000;
    }
    function staleSec() { return Math.max(Math.round(intervalMs() / 1000) * 3, 30); }

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
      if (mode !== "meters") list.push({
        id: "branch", label: "Git · ветка", type: "status",
        fields: { "number": { label: "Изменённых файлов", kind: "number" } },
      });
      if (mode !== "status") list.push({ id: "files", label: "Git · файлы", type: "meters" });
      ctx.cards.declare(list);
    }

    function renderStatus(branch, st, ok) {
      if (cardMode() === "meters") { ctx.cards.remove("branch"); return; }
      const p = {
        type: "status",
        icon: "git",
        badge: "GIT",                                     // заголовок карточки — «GIT»
        badgeKind: ok && st.files > 0 ? "accent" : "plain",
        line1: ok ? labelOf(branch) : "не git-репозиторий",
        line2: ok ? ("+" + st.added + " −" + st.removed + " · " + st.files + " файл.") : "",
        state: ok ? branch : "нет",
      };
      if (ok) p.number = st.files;              // число изменённых файлов → на шину
      ctx.cards.upsert("branch", p, widthOpts({ band: 4, order: 1, stalenessSec: staleSec() }));
    }

    function renderFiles(st) {
      if (cardMode() === "status") { ctx.cards.remove("files"); return; }
      const top = st.perFile.slice().sort((a, b) => b.lines - a.lines).slice(0, 4);
      const max = top.length ? top[0].lines : 1;
      const rows = top.length
        ? top.map(f => ({ label: baseName(f.path), pct: Math.max(3, Math.round(f.lines * 100 / (max || 1))) }))
        : [{ label: "нет изменений", pct: 0 }];
      ctx.cards.upsert("files", { type: "meters", title: "GIT · СТРОК ИЗМЕНЕНО", rows: rows },
                       widthOpts({ band: 4, order: 2, stalenessSec: staleSec() }));
    }

    function poll() {
      if (polling) return;
      const repo = repoOf(ctx);
      if (!repo) { ctx.status.set("warn", "укажите папку репозитория"); return; }
      polling = true;

      ctx.exec.run("branch", { repo: repo })
        .then(br => {
          if (br.code !== 0) {                  // не git-репозиторий / git недоступен
            ctx.status.set("error", (br.stderr || "не git-репозиторий").trim().slice(0, 80));
            renderStatus("", null, false);
            ctx.cards.remove("files");
            return;
          }
          const branch = (br.stdout || "").trim() || "—";
          // diffstat может упасть в репо без коммитов (нет HEAD) → тогда 0 изменений
          return ctx.exec.run("diffstat", { repo: repo })
            .then(ds => (ds.code === 0 ? parseNumstat(ds.stdout) : parseNumstat("")))
            .catch(() => parseNumstat(""))
            .then(st => {
              renderStatus(branch, st, true);
              renderFiles(st);
              ctx.status.set("ok", branch + " · +" + st.added + " −" + st.removed);
            });
        })
        .catch(e => { ctx.log.warn("git: " + e); ctx.status.set("error", String(e)); })
        .then(() => { polling = false; }, () => { polling = false; });
    }

    function reschedule() {
      if (pollTimer !== -1) ctx.timers.clear(pollTimer);
      pollTimer = ctx.timers.setInterval(poll, intervalMs());
    }

    ctx.cards.icon("git", gitIcon());
    declare();
    poll();
    reschedule();

    ctx.settings.onChange(() => { declare(); poll(); reschedule(); });
  },

  deactivate() {
    // таймеры хост закрывает сам
  },
});
