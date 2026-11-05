// Docker для Usee — статус демона и контейнеры (CPU/RAM) на дисплее.
//
// Docker Engine API — это HTTP. На Windows/Docker Desktop он слушает named pipe
// \\.\pipe\docker_engine — fetch("pipe://docker_engine/…") (разрешение pipe). Если
// задан TCP-адрес демона (настройка endpoint, напр. 127.0.0.1:2375) — обычный http://.

function base(ctx) {
  const ep = String(ctx.settings.get("endpoint") ?? "").trim()
    .replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return ep ? "http://" + ep : "pipe://docker_engine";
}

async function get(ctx, path) {
  const r = await fetch(base(ctx) + path);
  if (!r.ok) throw new Error("Docker: HTTP " + r.status);
  return r.json();
}

function shortName(c) {
  const n = String((c.Names && c.Names[0]) || c.Image || c.Id || "?").replace(/^\//, "");
  return n.length > 16 ? n.slice(0, 15) + "…" : n;
}

function cpuPct(s) {
  const cpu = s?.cpu_stats, pre = s?.precpu_stats;
  if (!cpu?.cpu_usage || !pre?.cpu_usage) return 0;
  const cd = (cpu.cpu_usage.total_usage || 0) - (pre.cpu_usage.total_usage || 0);
  const sd = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const cores = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  return sd > 0 && cd > 0 ? (cd / sd) * cores * 100 : 0;
}

function memPct(s) {
  const m = s?.memory_stats;
  if (!m?.limit) return 0;
  const used = (m.usage || 0) - (m.stats?.cache || 0);  // Docker вычитает cache из «used»
  return used > 0 ? (used / m.limit) * 100 : 0;
}

definePlugin({
  cards: {
    docker: { label: "Docker · статус", type: "status",
              fields: { number: { label: "Запущено контейнеров", kind: "number" } } },
    stats: { label: "Docker · контейнеры", type: "meters" },
  },

  activate(ctx) {
    const useMem = ctx.settings.get("metric") === "mem";
    const label = String(ctx.settings.get("label") || "Docker").toUpperCase();

    ctx.poll(async () => {
      let all;
      try {
        all = await get(ctx, "/containers/json?all=1");
      } catch (e) {
        // демон недоступен: счётчик неизвестен — number не выдумываем
        ctx.cards.docker.set({ icon: "containers", line1: label, line2: "демон недоступен",
                               badge: "—", state: "down", is_on: false });
        ctx.cards.stats.remove();
        throw e;
      }
      const running = all.filter(c => c.State === "running");
      ctx.cards.docker.set({
        icon: "containers", line1: label, line2: `${running.length} / ${all.length} контейнеров`,
        badge: String(running.length), badgeKind: running.length ? "accent" : "plain",
        state: "up", is_on: true, number: running.length,
      });

      // Мини-бары дороги (по запросу на контейнер) — только если карточку разместили.
      if (ctx.cards.placed().includes("stats")) {
        const rows = [];
        for (const c of running) {                      // по одному: у демона очередь
          const s = await get(ctx, `/containers/${c.Id}/stats?stream=false`).catch(() => null);
          const pct = s ? (useMem ? memPct(s) : cpuPct(s)) : 0;
          rows.push({ label: shortName(c), pct: Math.max(0, Math.min(100, Math.round(pct))) });
        }
        rows.sort((a, b) => b.pct - a.pct);
        ctx.cards.stats.set({
          title: "КОНТЕЙНЕРЫ · " + (useMem ? "RAM %" : "CPU %"),
          rows: rows.length ? rows.slice(0, 4) : [{ label: "нет запущенных", pct: 0 }],
        }, { stalenessSec: 120 });                      // сбор идёт ~секунду на контейнер
      }
      return `Docker · ${running.length}/${all.length} контейнеров`;
    }, { everySetting: "intervalSec" });
  },
});
