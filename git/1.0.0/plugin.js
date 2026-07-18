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
const IC_GIT = rgb565(0xF0, 0x51, 0x33);     // git-оранжевый
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
function gitIcon() {
  const px = new Array(ICON * ICON);
  for (let i = 0; i < px.length; i++) px[i] = IC_BG;
  function set(x, y, c) { if (x >= 0 && x < ICON && y >= 0 && y < ICON) px[y * ICON + x] = c; }
  function disc(cx, cy, r, c) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx + x, cy + y, c);
  }
  function line(x0, y0, x1, y1, c) {           // простой Брезенхэм
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
  line(8, 6, 8, 18, IC_GIT);                   // основная ветка
  line(8, 12, 16, 7, IC_GIT);                  // ответвление
  disc(8, 6, 2, IC_GIT);                       // коммиты
  disc(8, 18, 2, IC_GIT);
  disc(16, 7, 2, IC_GIT);                      // коммит на ветке
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
        line1: ok ? labelOf(branch) : "GIT",
        line2: ok ? ("+" + st.added + " −" + st.removed + " · " + st.files + " файл.") : "не git-репозиторий",
        badge: ok ? String(st.files) : "—",
        badgeKind: ok && st.files > 0 ? "accent" : "plain",
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
