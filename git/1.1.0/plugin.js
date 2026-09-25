// Git для Usee — ветка и незакоммиченные изменения папки на дисплее.
//
// Git живёт в файлах и CLI, до которых у песочницы доступа нет, поэтому плагин
// вызывает ОБЪЯВЛЕННЫЕ в манифесте команды («branch», «diffstat») и передаёт лишь
// значение дырки {repo}: хост проверяет, что путь остаётся под настройкой
// repoPath, а человек видел эти команды на экране разрешений при установке.

// `git diff --numstat HEAD`: строки "добавлено\tудалено\tпуть" (у бинарников — "-").
function parseNumstat(out) {
  const files = [];
  for (const line of out.split("\n")) {
    // Не `const [a, r, ...rest] = …`: в Jint 4.12 rest у массива короче трёх
    // получает длину 4294967295, и join съедает всю память (гоча в гайде).
    const t = line.split("\t");
    if (t.length < 3) continue;
    const path = t.slice(2).join("\t").trim();
    const added = parseInt(t[0], 10) || 0, removed = parseInt(t[1], 10) || 0;
    if (path) files.push({ path, added, removed, lines: added + removed });
  }
  return files;
}

function baseName(p) {
  const n = p.split(/[\\/]/).pop() || p;
  return n.length > 16 ? n.slice(0, 15) + "…" : n;
}

definePlugin({
  cards: {
    branch: { label: "Git · ветка", type: "status",
              fields: { number: { label: "Изменённых файлов", kind: "number" } } },
    files: { label: "Git · файлы", type: "meters" },
  },

  activate(ctx) {
    const repo = String(ctx.settings.get("repoPath") ?? "").trim();
    if (!repo) { ctx.status.set("warn", "укажите папку репозитория"); return; }

    ctx.poll(async () => {
      const br = await ctx.exec.run("branch", { repo });
      if (br.code !== 0) {                              // не git-репозиторий / git недоступен
        ctx.cards.branch.set({ icon: "git-branch", badge: "", line1: "не git-репозиторий", state: "нет" });
        ctx.cards.files.remove();
        throw new Error((br.stderr || "не git-репозиторий").trim().slice(0, 80));
      }
      const branch = br.stdout.trim() || "—";
      // в репо без коммитов (нет HEAD) diffstat падает — это «изменений нет»
      const ds = await ctx.exec.run("diffstat", { repo }).catch(() => ({ code: 1, stdout: "" }));
      const files = ds.code === 0 ? parseNumstat(ds.stdout) : [];
      const added = files.reduce((s, f) => s + f.added, 0);
      const removed = files.reduce((s, f) => s + f.removed, 0);

      ctx.cards.branch.set({
        icon: "git-branch", badge: "",                  // идентичность несёт иконка
        badgeKind: files.length ? "accent" : "plain",
        line1: String(ctx.settings.get("label") || branch),
        line2: `+${added} −${removed} · ${files.length} файл.`,
        state: branch, number: files.length,            // число файлов → шина значений
      });
      const top = files.sort((x, y) => y.lines - x.lines).slice(0, 4);
      const max = top[0]?.lines || 1;
      ctx.cards.files.set({
        title: "GIT · СТРОК ИЗМЕНЕНО",
        rows: top.length ? top.map(f => ({ label: baseName(f.path), pct: Math.max(3, Math.round(f.lines * 100 / max)) }))
                         : [{ label: "нет изменений", pct: 0 }],
      });
      return `${branch} · +${added} −${removed}`;
    }, { everySetting: "intervalSec" });
  },
});
