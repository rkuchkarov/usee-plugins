// Помодоро (usee-timer-plan.md; решения владельца 23.11.2026): фокус → отдых (после последнего раунда — долгий) → снова
// фокус. Вид и ход секунд — у прибора: карточка «Таймер» (тип 18) получает конец фазы, секунды прибор считает сам по своим
// часам, кадр уходит только при смене состояния. Конец фазы — экран-уведомление во весь экран с круглыми кнопками
// (ctx.screen.notify): отдых начинается сам через autoSec, фокус — только касанием (по умолчанию). Экран отдыха — сцена
// плагина «Отдых» по is_on карточки: от начала отдыха до следующего запуска фокуса. Состояние переживает перезапуск агента
// (ctx.storage); итог дня и недели — по местному времени ПК.

const TONE = { ready: "blue", focus: "red", break: "green", long: "violet" };
const NUM = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь"];
const LATE_MS = 10 * 60 * 1000;          // фаза кончилась, пока агента не было, давнее — без уведомления
const DAYS_KEPT = 14;                    // дней в итоге (неделя — последние семь)

definePlugin({
  cards: {
    timer: {
      label: "Помодоро",
      type: "timer",
      // касание — старт или пауза; удержание (1 с с кольцом) — сброс; свайп вправо — плюс минуты, влево — пропустить фазу
      input: { tap: "toggle", hold: "reset", right: "plus", left: "skip" },
    },
  },
  actions: {
    toggle: { label: "Помодоро: старт или пауза" },
    reset: { label: "Помодоро: сброс" },
    plus: { label: "Помодоро: плюс минуты" },
    skip: { label: "Помодоро: пропустить фазу" },
    next: { label: "Помодоро: следующая фаза" },
    more: { label: "Помодоро: ещё минуты к фазе" },
    stop: { label: "Помодоро: стоп" },
    idle: { label: "Помодоро: уведомление без ответа" },
  },

  activate(ctx) {
    const set = (k) => ctx.settings.get(k);
    const rounds = () => Math.max(1, Math.min(8, Math.round(set("rounds") || 4)));
    const minutes = (k, def) => Math.max(1, Math.round(set(k) || def)) * 60;
    const focusSec = () => minutes("focusMin", 25);
    const breakSec = () => minutes("breakMin", 5);
    const longSec = () => minutes("longMin", 15);
    const plusSec = () => minutes("plusMin", 5);

    // ---- состояние ----
    // phase: ready | focus | break | long; mode: ready | run | pause | done (фаза кончилась, ждёт ответа);
    // done — пройдено раундов в цикле; rest — экран отдыха (is_on карточки).
    const fresh = () => ({ phase: "ready", mode: "ready", endsAt: 0, left: 0, dur: focusSec(), done: 0, rest: false,
                           notice: 0, last: "", days: {} });
    let s = Object.assign(fresh(), ctx.storage.get("state") || {});
    let timer = 0;

    const save = () => ctx.storage.set("state", s);
    const pad = (n) => (n < 10 ? "0" : "") + n;
    const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
    const mmss = (sec) => Math.floor(sec / 60) + ":" + pad(sec % 60);
    const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    const duration = (sec) => {
      const m = Math.round(sec / 60);
      return m < 60 ? m + " мин" : Math.floor(m / 60) + " ч" + (m % 60 ? " " + (m % 60) : "");
    };

    // ---- итог дня и недели ----
    function countFocus(sec, n) {
      const k = dayKey(Date.now());
      const d = s.days[k] || { n: 0, sec: 0 };
      d.n = Math.max(0, d.n + n);
      d.sec = Math.max(0, d.sec + sec);
      s.days[k] = d;
      const keys = Object.keys(s.days).sort();
      while (keys.length > DAYS_KEPT) delete s.days[keys.shift()];
    }
    function weekShares() {
      const now = Date.now(), secs = [];
      for (let i = 6; i >= 0; i--) secs.push((s.days[dayKey(now - i * 86400000)] || { sec: 0 }).sec);
      const max = Math.max.apply(null, secs);
      return max > 0 ? secs.map((x) => Math.round((x / max) * 100) / 100) : null;
    }

    // ---- карточка и сущности ----
    function publish() {
      const ready = s.phase === "ready";
      const card = {
        tone: TONE[s.phase],
        word: s.mode === "pause" ? "Пауза" : s.mode === "done" ? "Готово" : ready ? "Начать" : s.phase === "focus" ? "Фокус" : "Отдых",
        durSec: s.dur,
        rounds: rounds(),
        done: Math.min(s.done, rounds()),
        current: s.phase === "focus" && (s.mode === "run" || s.mode === "pause"),
        is_on: s.rest,
        state: s.mode === "pause" ? "pause" : s.mode === "done" ? "wait" : s.phase,
      };
      if (s.mode === "run") {
        card.endsAt = s.endsAt;
        card.at = { word: s.phase === "focus" ? "отдых в" : "фокус в", time: hhmm(s.endsAt) };
      } else if (s.mode === "pause") {
        card.mode = "pause";
        card.left = s.left;
      } else if (s.mode === "done") {
        card.mode = "done";
        card.left = 0;
      } else {
        card.mode = "ready";
        card.left = s.dur;
      }
      const today = s.days[dayKey(Date.now())];
      if (today && today.n > 0) card.today = { count: today.n, text: duration(today.sec) };
      const week = weekShares();
      if (week) card.week = week;
      ctx.cards.timer.set(card, { stalenessSec: 86400 });
      ctx.entities.setMany({
        phase: s.mode === "pause" ? "пауза" : s.mode === "done" ? "ждёт"
             : { ready: "готов", focus: "фокус", break: "отдых", long: "долгий" }[s.phase],
        left: s.mode === "run" ? Math.max(0, Math.round((s.endsAt - Date.now()) / 1000)) : s.mode === "pause" ? s.left : 0,
      });
      s.last = dayKey(Date.now());
      save();
    }

    // ---- ход ----
    function schedule() {
      if (timer) ctx.timers.clear(timer);
      timer = 0;
      if (s.mode === "run") timer = ctx.timers.setTimeout(() => { timer = 0; phaseEnd(false); }, Math.max(0, s.endsAt - Date.now()));
    }
    function closeNotice() {
      if (s.notice) ctx.screen.close(s.notice);
      s.notice = 0;
    }
    function run(phase, dur) {
      closeNotice();
      s.phase = phase;
      s.mode = "run";
      s.dur = dur;
      s.endsAt = Date.now() + dur * 1000;
      s.left = 0;
      s.rest = phase !== "focus";          // экран отдыха — от начала отдыха до запуска фокуса (решение 14)
      schedule();
      publish();
    }
    const startFocus = () => run("focus", focusSec());
    const startBreak = () => {
      const long = s.done >= rounds();
      run(long ? "long" : "break", long ? longSec() : breakSec());
    };
    function readyForFocus() {
      closeNotice();
      s.mode = "ready";
      s.phase = "ready";
      s.dur = focusSec();
      s.endsAt = 0;
      s.left = 0;
      schedule();
      publish();
    }

    // Фаза дотикала (или её пропустили). late — кончилась, пока агента не было.
    function phaseEnd(late, silent) {
      if (s.phase === "focus") {
        s.done = Math.min(rounds(), s.done + 1);
        countFocus(s.dur, 1);
      } else if (s.phase === "long") {
        s.done = 0;                        // цикл пройден — следующий фокус первый
      }
      s.mode = "done";
      s.left = 0;
      schedule();
      publish();
      if (silent) return;
      const wasFocus = s.phase === "focus";
      if (!set("notify") || (late && Date.now() - s.endsAt > LATE_MS)) {
        // без уведомления: автостарт сразу, иначе — ждёт касания (фокус после отдыха — «Начать»)
        if (wasFocus && set("autoBreak")) startBreak();
        else if (!wasFocus && set("autoFocus")) startFocus();
        else if (!wasFocus) readyForFocus();
        return;
      }
      notify(wasFocus);
    }

    function notify(wasFocus) {
      const autoSec = Math.round(set("autoSec") || 15), holdSec = Math.round(set("holdSec") || 60);
      const plus = "+" + Math.round(plusSec() / 60);
      if (wasFocus) {
        const long = s.done >= rounds();
        const auto = !!set("autoBreak");
        const n = rounds();
        s.notice = ctx.screen.notify({
          tone: long ? "violet" : "green",
          title: long && n > 1 ? NUM[n].charAt(0).toUpperCase() + NUM[n].slice(1) + (n < 5 ? " фокуса" : " фокусов") + " подряд" : "Фокус окончен",
          sub: auto ? "отдых начнётся сам через *{s} с*" : long ? "дальше — долгий отдых" : "дальше — отдых",
          value: mmss(long ? longSec() : breakSec()),
          word: "Отдых",
          rounds: n,
          done: s.done,
          buttons: [
            { text: plus, label: "ещё фокус", action: "more" },
            { icon: "play", label: "отдых", action: "next", primary: true },
            { icon: "stop", label: long ? "хватит" : "стоп", action: "stop" },
          ],
          auto: auto ? { sec: autoSec } : undefined,
          hold: auto ? undefined : { sec: holdSec, action: "idle" },
        });
      } else {
        const auto = !!set("autoFocus");
        s.notice = ctx.screen.notify({
          tone: "red",
          title: "Отдых окончен",
          sub: auto ? "фокус начнётся сам через *{s} с*" : "дальше — фокус *" + (s.done + 1) + "* из " + rounds(),
          value: mmss(focusSec()),
          word: "Фокус",
          rounds: rounds(),
          done: s.done,
          buttons: [
            { text: plus, label: "ещё отдых", action: "more" },
            { icon: "play", label: "фокус", action: "next", primary: true },
            { icon: "stop", label: "стоп", action: "stop" },
          ],
          auto: auto ? { sec: autoSec } : undefined,
          hold: auto ? undefined : { sec: holdSec, action: "idle" },     // без ответа — «Начать», экран отдыха стоит
        });
      }
      save();
    }

    // ---- действия: жесты карточки и кнопки уведомления ----
    function next() {
      if (s.phase === "focus") startBreak();
      else startFocus();
    }
    function toggle() {
      if (s.mode === "ready") startFocus();
      else if (s.mode === "run") {
        s.left = Math.max(1, Math.ceil((s.endsAt - Date.now()) / 1000));
        s.mode = "pause";
        schedule();
        publish();
      } else if (s.mode === "pause") {
        s.mode = "run";
        s.endsAt = Date.now() + s.left * 1000;
        schedule();
        publish();
      } else next();                         // «Готово» — касание начинает следующую фазу
    }
    // Плюс минуты: идущей или стоящей на паузе фазе — к концу; кончившейся — продолжение той же фазы (раунд фокуса снова
    // не засчитан, пока продолжение не кончится).
    function plus() {
      const add = plusSec();
      if (s.mode === "run") { s.endsAt += add * 1000; s.dur += add; schedule(); publish(); }
      else if (s.mode === "pause") { s.left += add; s.dur += add; publish(); }
      else if (s.mode === "done") more();
    }
    function more() {
      const add = plusSec();
      closeNotice();
      if (s.phase === "focus") {
        s.done = Math.max(0, s.done - 1);
        countFocus(-s.dur, -1);              // засчитается, когда продолжение кончится — целиком
      } else if (s.phase === "long") {
        s.done = rounds();                   // долгий отдых продолжается — цикл ещё не начат заново
      }
      if (s.phase === "ready") return startFocus();
      s.mode = "run";
      s.dur += add;
      s.endsAt = Date.now() + add * 1000;
      s.rest = s.phase !== "focus";
      schedule();
      publish();
    }
    function skip() {
      if (s.mode === "ready") return startFocus();
      if (s.mode === "done") return next();
      if (s.phase === "focus") {             // фокус засчитан тем, что прошло
        const gone = Math.max(0, s.dur - (s.mode === "run" ? Math.ceil((s.endsAt - Date.now()) / 1000) : s.left));
        s.dur = gone;
      }
      phaseEnd(false, true);
      next();
    }
    function reset() {
      closeNotice();
      s.done = 0;
      s.rest = false;
      readyForFocus();
    }
    function idle() {                        // уведомление без ответа (вышел срок): после отдыха — «Начать»
      s.notice = 0;
      if (s.phase === "break" || s.phase === "long") readyForFocus();
      else publish();
    }

    ctx.actions.toggle.on(() => { toggle(); });
    ctx.actions.reset.on(() => { reset(); });
    ctx.actions.plus.on(() => { plus(); });
    ctx.actions.skip.on(() => { skip(); });
    ctx.actions.next.on(() => { next(); });
    ctx.actions.more.on(() => { more(); });
    ctx.actions.stop.on(() => { reset(); });
    ctx.actions.idle.on(() => { idle(); });

    ctx.entities.declare([
      { id: "phase", label: "Фаза", kind: "string", states: ["готов", "фокус", "отдых", "долгий", "ждёт", "пауза"] },
      { id: "left", label: "Осталось", kind: "number", unit: "с" },
    ]);

    // настройки: «Начать» берёт новую длину фокуса; прочее — со следующей фазы
    ctx.settings.onChange(() => {
      if (s.mode === "ready") s.dur = focusSec();
      publish();
    });
    // новый день — итог дня и неделя заново (раз в минуту, без смены фазы кадр не уходит)
    ctx.timers.setInterval(() => { if (s.last !== dayKey(Date.now())) publish(); }, 60000);

    // ---- после перезапуска агента ----
    s.notice = 0;                            // прибор уведомление не помнит: агент поднимается заново
    if (s.mode === "run" && s.endsAt <= Date.now()) phaseEnd(true);
    else {
      if (s.mode === "ready") s.dur = focusSec();
      schedule();
      publish();
    }
  },
});
