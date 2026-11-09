// Git для Usee — статус репозитория, ветка, изменения и последний коммит.
//
// 1.3.0 (SDK 11):
// - опрос через `status --porcelain=v2 --branch` (видит untracked, ahead/behind, detached HEAD, конфликты);
// - `diff --numstat HEAD` для подсчёта строк и ранжирования файлов;
// - `log -1` для времени (eventAt) и темы коммита (detail);
// - адаптивные тексты вариантами (FitText), бейдж состояния (акцент, ошибка, чисто);
// - шина сущностей: number (число файлов), is_on (грязный).

function parseStatus(out) {
  let branch = "—", oid = "", upstream = "", ahead = 0, behind = 0;
  let staged = 0, unstaged = 0, untracked = 0, conflicts = 0;
  const untrackedFiles = [];
  const changedFiles = [];

  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice(14).trim();
    } else if (line.startsWith("# branch.oid ")) {
      oid = line.slice(13).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice(18).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10) || 0;
        behind = parseInt(m[2], 10) || 0;
      }
    } else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      if (parts.length >= 2) {
        const xy = parts[1];
        if (xy[0] !== ".") staged++;
        if (xy[1] !== ".") unstaged++;
      }
      const p = parts.slice(8).join(" ").trim();
      if (p) changedFiles.push(p);
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      if (parts.length >= 2) {
        const xy = parts[1];
        if (xy[0] !== ".") staged++;
        if (xy[1] !== ".") unstaged++;
      }
      const rest = parts.slice(9).join(" ");
      const p = rest.split("\t")[0].trim();
      if (p) changedFiles.push(p);
    } else if (line.startsWith("u ")) {
      conflicts++;
      const p = line.split(" ").slice(10).join(" ").trim();
      if (p) changedFiles.push(p);
    } else if (line.startsWith("? ")) {
      untracked++;
      const p = line.slice(2).trim();
      if (p) {
        untrackedFiles.push(p);
        changedFiles.push(p);
      }
    }
  }

  const isDetached = branch === "(detached)" || branch === "HEAD";
  const displayBranch = isDetached
    ? (oid && oid !== "(initial)" ? `detached (${oid.slice(0, 7)})` : "HEAD")
    : branch;

  return {
    branch: displayBranch,
    rawBranch: branch,
    oid: oid !== "(initial)" ? oid : "",
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicts,
    untrackedFiles,
    changedFiles,
    totalFiles: changedFiles.length,
  };
}

function parseNumstat(out) {
  const files = [];
  for (const line of out.split("\n")) {
    // Не деструктурировать [...rest]: в Jint 4.12 rest у короткого массива съедает память
    const t = line.split("\t");
    if (t.length < 3) continue;
    const path = t.slice(2).join("\t").trim();
    const added = parseInt(t[0], 10) || 0, removed = parseInt(t[1], 10) || 0;
    if (path) files.push({ path, added, removed, lines: added + removed });
  }
  return files;
}

function parseCommit(out) {
  const line = (out || "").trim().split("\n")[0];
  if (!line) return null;
  const t = line.split("\t");
  if (t.length < 3) return null;
  const time = parseInt(t[0], 10) || 0;
  const hash = t[1].trim();
  const subject = t.slice(2).join("\t").trim();
  return { time, hash, subject };
}

function baseName(p) {
  return p.split(/[\\/]/).pop() || p;
}

const g_enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function truncUtf8(str, max) {
  if (!str) return "";
  const s = String(str);
  if (!g_enc) return s.slice(0, max);
  if (g_enc.encode(s).length <= max) return s;
  let chars = Array.from(s);
  while (chars.length > 0 && g_enc.encode(chars.join("")).length > max) chars.pop();
  return chars.join("");
}

definePlugin({
  cards: {
    branch: {
      label: "Git · ветка",
      type: "status",
      fields: {
        number: { label: "Изменённых файлов", kind: "number" },
        is_on: { label: "Есть незакоммиченные изменения", kind: "bool" },
      },
    },
    files: {
      label: "Git · файлы",
      type: "meters",
    },
  },

  activate(ctx) {
    ctx.instances.each(inst => {
      const repo = String(inst.settings.get("repoPath") ?? "").trim();

      inst.poll(async () => {
        if (!repo) throw new Error("не указана папка репозитория");

        const stRes = await inst.exec.run("status", { repo });
        if (stRes.code !== 0) {
          inst.cards.branch.set({
            icon: "git-branch",
            badge: "ошибка",
            badgeKind: "plain",
            line1: "не git-репозиторий",
            state: "нет",
            is_on: false,
            number: 0,
          });
          inst.cards.files.remove();
          throw new Error((stRes.stderr || "не git-репозиторий").trim().slice(0, 80));
        }

        const st = parseStatus(stRes.stdout);

        // в репо без коммитов (нет HEAD) diffstat падает — это «0 строк»
        const dsRes = await inst.exec.run("diffstat", { repo }).catch(() => ({ code: 1, stdout: "" }));
        const numstatFiles = dsRes.code === 0 ? parseNumstat(dsRes.stdout) : [];

        // последний коммит: время (eventAt) и текст (detail)
        const lcRes = await inst.exec.run("last-commit", { repo }).catch(() => ({ code: 1, stdout: "" }));
        const commit = lcRes.code === 0 ? parseCommit(lcRes.stdout) : null;

        // объединяем отслеживаемые изменения и новые файлы
        const fileMap = new Map();
        for (const f of numstatFiles) {
          fileMap.set(f.path, { path: f.path, added: f.added, removed: f.removed, lines: f.lines, untracked: false });
        }
        for (const p of st.changedFiles) {
          if (!fileMap.has(p)) {
            fileMap.set(p, { path: p, added: 0, removed: 0, lines: 1, untracked: st.untrackedFiles.includes(p) });
          }
        }

        const allFiles = Array.from(fileMap.values());
        const added = allFiles.reduce((s, f) => s + f.added, 0);
        const removed = allFiles.reduce((s, f) => s + f.removed, 0);
        const totalFiles = Math.max(st.totalFiles, allFiles.length);

        // синхронизация с upstream (↑ahead ↓behind)
        const sync = st.ahead && st.behind
          ? `↑${st.ahead} ↓${st.behind}`
          : (st.ahead ? `↑${st.ahead}` : (st.behind ? `↓${st.behind}` : ""));

        // строка описания изменений
        const diffSummary = totalFiles > 0
          ? `+${added} −${removed} · ${totalFiles} файл.`
          : "нет изменений";

        // варианты второй строки для FitText (длинный на широкий экран, короткий на узкий)
        const line2Variants = sync
          ? [`${diffSummary}  ${sync}`, diffSummary, sync]
          : diffSummary;

        // бейдж в углу карточки
        let badge = "✓";
        let badgeKind = "plain";
        if (st.conflicts > 0) {
          badge = "КОНФЛИКТ";
          badgeKind = "rec";
        } else if (totalFiles > 0) {
          badge = `+${added} −${removed}`;
          badgeKind = "accent";
        } else if (sync) {
          badge = sync;
          badgeKind = "plain";
        }

        const branchPayload = {
          icon: "git-branch",
          badge,
          badgeKind,
          line1: st.conflicts > 0 ? [`${st.branch} · КОНФЛИКТ`, "КОНФЛИКТ МЕРЖА", st.branch] : st.branch,
          line2: line2Variants,
          state: st.branch,
          number: totalFiles,
          is_on: totalFiles > 0 || st.conflicts > 0,
        };

        if (commit?.time) branchPayload.eventAt = commit.time;
        if (commit?.hash) branchPayload.detail = truncUtf8(`${commit.hash} · ${commit.subject}`, 39);

        inst.cards.branch.set(branchPayload);

        // Карточка файлов (meters)
        const top = allFiles.sort((x, y) => y.lines - x.lines).slice(0, 4);
        const maxLines = top[0]?.lines || 1;
        const rows = top.length
          ? top.map(f => {
              const sec = f.untracked ? "новый" : (f.added || f.removed ? `+${f.added} −${f.removed}` : "");
              return {
                label: baseName(f.path),
                label16: f.path.length > 27 ? "…" + f.path.slice(-24) : f.path,
                pct: Math.max(3, Math.round(f.lines * 100 / maxLines)),
                sec: sec.slice(0, 11),
              };
            })
          : [{ label: ["нет изменений", "нет правок"], pct: 0 }];

        const footer = totalFiles > 0
          ? `всего: +${added} −${removed} · ${totalFiles} файл.`
          : "";

        inst.cards.files.set({
          title: "GIT · ФАЙЛЫ",
          rows,
          ...(footer ? { footer } : {}),
        });

        // Строка статуса плагина в списке плагинов
        const who = ctx.instances.list().length > 1 ? inst.name + ": " : "";
        const syncPart = sync ? ` · ${sync}` : "";
        return `${who}${st.branch} · +${added} −${removed}${syncPart}`;
      }, { everySetting: "intervalSec" });
    });
  },
});
