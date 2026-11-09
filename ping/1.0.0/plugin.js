// @ts-check
/// <reference path="../../usee-plugin-template/sdk/usee-plugin.d.ts" />
// Пинг сети для Usee (SDK 11) — измерение RTT, потерь и джиттера через локальный ping.
// Карточки: «график» (spark), «статус» (status) и «котировка/сводка» (message).

const POPULAR_HOSTS = [
  { id: "1.1.1.1", label: "Cloudflare DNS (1.1.1.1)", detail: "1.1.1.1" },
  { id: "8.8.8.8", label: "Google DNS (8.8.8.8)", detail: "8.8.8.8" },
  { id: "192.168.1.1", label: "Шлюз роутера (192.168.1.1)", detail: "192.168.1.1" },
  { id: "192.168.0.1", label: "Шлюз роутера (192.168.0.1)", detail: "192.168.0.1" },
  { id: "ya.ru", label: "Яндекс (ya.ru)", detail: "ya.ru" },
  { id: "google.com", label: "Google (google.com)", detail: "google.com" },
  { id: "github.com", label: "GitHub (github.com)", detail: "github.com" },
];

function parsePingOutput(stdout) {
  if (!stdout) return { ok: false, rtt: null, loss: 100 };

  // 1. Поиск RTT в строке ответа или сводке
  // Linux / Win EN: "time=14ms", "time<1ms", "time=14.2 ms"
  let m = stdout.match(/time[=<](\d+(?:\.\d+)?)\s*ms/i);
  // Win RU / другие локали (включая несовпадение кодовой страницы CP866/UTF-8):
  if (!m) m = stdout.match(/(?:время|time)?[=|<]\s*(\d+(?:\.\d+)?)\s*(?:ms|мс|[^\w\s]+)?\s+TTL=\d+/i);
  // Резерв по строке среднего времени в блоке сводки
  if (!m) m = stdout.match(/=\s*(\d+(?:\.\d+)?)\s*(?:ms|мс|ᥪ)?\s*$/m);

  const rtt = m ? parseFloat(m[1]) : null;

  // 2. Поиск потерь
  // Linux: "0% packet loss" / "0% loss"
  let lossMatch = stdout.match(/(\d+)%\s*(?:packet\s*)?loss/i);
  // Windows: "(0% потерь)" / "(0% loss)"
  if (!lossMatch) lossMatch = stdout.match(/\((\d+)%/);

  const loss = lossMatch ? parseInt(lossMatch[1], 10) : (rtt !== null ? 0 : 100);

  return {
    ok: rtt !== null && loss < 100,
    rtt,
    loss,
  };
}

class PingTracker {
  constructor(size = 30) {
    this.size = size;
    /** @type {{ ok: boolean, rtt: number | null }[]} */
    this.history = [];
  }

  push(ok, rtt) {
    this.history.push({ ok, rtt });
    if (this.history.length > this.size) this.history.shift();
  }

  calc() {
    if (this.history.length === 0) {
      return { cur: null, min: 0, max: 0, avg: 0, loss: 0, jitter: 0, ok: false };
    }

    const oks = this.history
      .filter(h => h.ok && typeof h.rtt === "number")
      .map(h => /** @type {number} */ (h.rtt));

    const loss = Math.round(((this.history.length - oks.length) / this.history.length) * 100);

    if (oks.length === 0) {
      return { cur: null, min: 0, max: 0, avg: 0, loss: 100, jitter: 0, ok: false };
    }

    const cur = oks[oks.length - 1];
    let min = oks[0], max = oks[0], sum = 0;
    for (const v of oks) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const avg = Math.round((sum / oks.length) * 10) / 10;

    let diffSum = 0, diffCount = 0;
    for (let i = 1; i < oks.length; i++) {
      diffSum += Math.abs(oks[i] - oks[i - 1]);
      diffCount++;
    }
    const jitter = diffCount > 0 ? Math.round((diffSum / diffCount) * 10) / 10 : 0;

    return {
      cur,
      min: Math.round(min),
      max: Math.round(max),
      avg,
      loss,
      jitter,
      ok: true,
    };
  }
}

definePlugin({
  cards: {
    chart: { label: "График задержки (chart)", type: "spark" },
    status: { label: "Статус пинга (status)", type: "status" },
    quote: { label: "Сводка (quote)", type: "message" },
  },

  activate(ctx) {
    const intervalSec = Math.max(1, Number(ctx.settings.get("intervalSec")) || 3);
    const timeoutMs = Math.max(200, Number(ctx.settings.get("timeoutMs")) || 1000);

    // Автоопределение команды ОС: "ping-nix" (Linux/macOS) или "ping-win" (Windows)
    let detectedCmd = null;

    async function probePing(targetHost) {
      if (detectedCmd) {
        const vars = detectedCmd === "ping-win"
          ? { host: targetHost, timeout: Math.round(timeoutMs) }
          : { host: targetHost };
        return await ctx.exec.run(detectedCmd, vars);
      }

      // Пробуем ping-win (Windows)
      try {
        const resWin = await ctx.exec.run("ping-win", { host: targetHost, timeout: Math.round(timeoutMs) });
        if (resWin.code === 0 || (resWin.stdout && /time[=<]/i.test(resWin.stdout))) {
          detectedCmd = "ping-win";
          return resWin;
        }
      } catch (err) {
        // не ping-win
      }

      // Пробуем ping-nix (Linux/macOS)
      try {
        const resNix = await ctx.exec.run("ping-nix", { host: targetHost });
        if (resNix.code === 0 || (resNix.stdout && /time[=<]/i.test(resNix.stdout))) {
          detectedCmd = "ping-nix";
          return resNix;
        }
      } catch (err) {
        // не ping-nix
      }

      // Если ни один не дал явного успеха, пробуем ping-win как запасной
      detectedCmd = "ping-win";
      return await ctx.exec.run("ping-win", { host: targetHost, timeout: Math.round(timeoutMs) });
    }

    // Объявляем сущности в шине значений
    const entitiesList = [];
    ctx.instances.each(inst => {
      const prefix = inst.id && inst.id !== "1" ? `ping.${inst.id}.` : "ping.";
      const nameSuffix = inst.name ? ` (${inst.name})` : "";
      entitiesList.push(
        { id: `${prefix}rtt`, label: `Задержка${nameSuffix}`, kind: "number", unit: "мс" },
        { id: `${prefix}avg`, label: `Средняя задержка${nameSuffix}`, kind: "number", unit: "мс" },
        { id: `${prefix}loss`, label: `Потери${nameSuffix}`, kind: "number", unit: "%" },
        { id: `${prefix}jitter`, label: `Джиттер${nameSuffix}`, kind: "number", unit: "мс" },
        { id: `${prefix}online`, label: `Доступен${nameSuffix}`, kind: "bool" }
      );
    });
    ctx.entities.declare(entitiesList);

    // Запускаем опрос каждого экземпляра
    ctx.instances.each(inst => {
      const tracker = new PingTracker(30);

      inst.poll(async () => {
        const host = String(inst.settings.get("host") || "1.1.1.1").trim();
        const customName = String(inst.settings.get("name") || "").trim();
        const displayLabel = customName || host;

        let pingResult;
        try {
          const raw = await probePing(host);
          pingResult = parsePingOutput(raw.stdout);
        } catch (err) {
          ctx.log.warn(`ошибка ping ${host}: ` + err);
          pingResult = { ok: false, rtt: null, loss: 100 };
        }

        tracker.push(pingResult.ok, pingResult.rtt);
        const st = tracker.calc();

        const currentRtt = st.cur !== null ? Math.round(st.cur) : null;
        const currentStr = currentRtt !== null ? `${currentRtt} мс` : "ОФФЛАЙН";

        // 1. Карточка «График» (spark)
        const sparkNum = currentRtt !== null ? currentRtt : 0;
        inst.cards.chart.set({
          label: displayLabel.toUpperCase(),
          number: sparkNum,
          unit: "мс",
          windowSec: tracker.size * intervalSec,
        });

        // Точка кривой: байт 0..255 (максимум прибора)
        if (currentRtt !== null) {
          inst.cards.chart.history(Math.min(255, currentRtt));
        }

        // 2. Карточка «Статус» (status)
        const badgeKind = !st.ok || st.loss > 0 || (currentRtt ?? 0) > 120
          ? "rec"
          : ((currentRtt ?? 0) > 60 ? "plain" : "accent");

        const line2Variants = [
          `мин ${st.min} · ср ${st.avg} · макс ${st.max} мс · потерь ${st.loss}%`,
          `мин ${st.min} · ср ${st.avg} · макс ${st.max} мс`,
          `ср ${st.avg} мс · потерь ${st.loss}%`,
          `ср ${st.avg} мс`,
        ];

        inst.cards.status.set({
          icon: st.loss === 0 && st.ok ? "bolt" : (st.loss < 50 ? "warn" : "cross"),
          line1: `${displayLabel} · ${currentStr}`,
          state: currentStr,
          number: currentRtt ?? undefined,
          badge: st.loss > 0 ? `${st.loss}% потерь` : currentStr,
          badgeKind,
          line2: line2Variants,
          detail: st.jitter > 0 ? `Джиттер: ±${st.jitter} мс` : undefined,
        });

        // 3. Карточка «Сводка» (message)
        const tone = st.ok && st.loss === 0 && (currentRtt ?? 0) < 50
          ? "good"
          : (st.ok && st.loss < 20 && (currentRtt ?? 0) < 100 ? "attention" : "problem");

        inst.cards.quote.set({
          title: `ПИНГ: ${displayLabel.toUpperCase()}`,
          titleShort: "ПИНГ",
          tone,
          num: currentRtt !== null ? String(currentRtt) : "—",
          unit: "мс",
          num2: st.loss > 0 ? String(st.loss) : (st.jitter > 0 ? `±${st.jitter}` : undefined),
          unit2: st.loss > 0 ? "%" : (st.jitter > 0 ? "мс" : undefined),
          expl: `мин ${st.min} · макс ${st.max} мс`,
          progress: currentRtt !== null ? Math.min(100, Math.round((currentRtt / 120) * 100)) : 100,
        });

        // 4. Сущности в шину
        const prefix = inst.id && inst.id !== "1" ? `ping.${inst.id}.` : "ping.";
        ctx.entities.setMany({
          [`${prefix}rtt`]: currentRtt,
          [`${prefix}avg`]: st.avg,
          [`${prefix}loss`]: st.loss,
          [`${prefix}jitter`]: st.jitter,
          [`${prefix}online`]: st.ok,
        });

        return `${displayLabel}: ${currentStr} (ср ${st.avg} мс)`;
      }, { everySec: intervalSec });
    });
  },

  providers: {
    suggestHosts(ctx, form) {
      const q = String((form && form.host) || "").trim().toLowerCase();
      if (!q) return POPULAR_HOSTS;
      return POPULAR_HOSTS.filter(h =>
        h.id.toLowerCase().includes(q) || h.label.toLowerCase().includes(q)
      );
    },
  },
});
