// Помодоро (usee-timer-plan.md; решения владельца 23.11.2026, переделка 25.11.2026 — §10.15): фокус → отдых (после
// последнего раунда — долгий) → снова фокус. Вид и ход секунд — у прибора: карточка «Таймер» (тип 18) получает конец фазы,
// секунды прибор считает сам по своим часам, кадр уходит только при смене состояния.
//
// Конец фазы и отдых — та же карточка во весь экран (SDK 18, ctx.cards.timer.open; слово владельца 25.11: «используя этот
// механизм, а не какой-то кастомный»): фокус дотикал — карточка раскрывается, в ней отсчёт «До отдыха 0:15», затем идёт
// отдых — во весь экран до запуска фокуса; фокус сворачивает её в своё место. Жестов у карточки нет (слово владельца 25.11:
// «уберем все жесты с этой карточки») — касание открывает её во весь экран, как любую; управление — действия плагина
// (кнопка «Помодоро» в сцене и в шторке). Состояние переживает перезапуск агента (ctx.storage); итог дня — по местному
// времени ПК.

const TONE = { ready: "blue", focus: "red", break: "green", long: "violet" };
const LATE_MS = 10 * 60 * 1000;          // фаза кончилась, пока агента не было, давнее — тихо, «Начать»
const DAYS_KEPT = 14;                    // дней в итоге (на карточке — сегодня)

definePlugin({
  cards: {
    timer: { label: "Помодоро", type: "timer" },
  },

  activate(ctx) {
    const set = (k) => ctx.settings.get(k);
    const rounds = () => Math.max(1, Math.min(8, Math.round(set("rounds") || 4)));
    const minutes = (k, def) => Math.max(1, Math.round(set(k) || def)) * 60;
    const focusSec = () => minutes("focusMin", 25);
    const breakSec = () => minutes("breakMin", 5);
    const longSec = () => minutes("longMin", 15);
    const plusSec = () => minutes("plusMin", 5);
    const autoSec = () => Math.max(3, Math.round(set("autoSec") || 15));
    const holdSec = () => Math.max(10, Math.round(set("holdSec") || 60));

    // ---- состояние ----
    // phase: ready | focus | break | long; mode: ready | run | pause | done (фаза кончилась, ждёт ответа) | auto (отсчёт до
    // автостарта следующей фазы — autoEnds); done — пройдено раундов в цикле; rest — экран отдыха: карточка во весь экран от
    // начала отдыха до запуска фокуса (решение 14); holdUntil — до какого мига «Готово» ждёт ответа (0 — не ждёт).
    const fresh = () => ({ phase: "ready", mode: "ready", endsAt: 0, left: 0, dur: focusSec(), done: 0, rest: false,
                           autoEnds: 0, autoDur: 0, holdUntil: 0, last: "", days: {} });
    let s = Object.assign(fresh(), ctx.storage.get("state") || {});
    delete s.notice;                         // поле 1.2.x: экрана-уведомления больше нет
    let timer = 0, ticker = 0;

    const save = () => ctx.storage.set("state", s);
    const pad = (n) => (n < 10 ? "0" : "") + n;
    const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
    const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    // Остаток идущей фазы, с, — ровно как на приборе: он показывает конец фазы (целая секунда вниз) минус целую секунду своих
    // часов, а часы сверены с ПК до доли секунды (ревью 24.11, находка 3). Пауза берёт его же — цифры не прыгают.
    const remain = (now) => Math.max(0, Math.floor(s.endsAt / 1000) - Math.floor(now / 1000));
    const duration = (sec) => {
      const m = Math.round(sec / 60);
      return m < 60 ? m + " мин" : Math.floor(m / 60) + " ч" + (m % 60 ? " " + (m % 60) : "");
    };
    // какая фаза следующая после кончившейся (для отсчёта автостарта)
    const nextPhase = () => (s.phase === "focus" ? (s.done >= rounds() ? "long" : "break") : "focus");

    // ---- итог дня ----
    function countFocus(sec, n, at) {
      const k = dayKey(at || Date.now());
      const d = s.days[k] || { n: 0, sec: 0 };
      d.n = Math.max(0, d.n + n);
      d.sec = Math.max(0, d.sec + sec);
      s.days[k] = d;
      const keys = Object.keys(s.days).sort();
      while (keys.length > DAYS_KEPT) delete s.days[keys.shift()];
    }

    // ---- во весь экран ----
    // open() — новая просьба: прибор раскроет карточку, даже если человек свернул её в прошлой фазе. «Во весь экран» выключен в
    // настройках — карточка остаётся на месте.
    function full(on) {
      if (on && set("notify")) ctx.cards.timer.open();
      else ctx.cards.timer.close();
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
        state: s.mode === "pause" ? "pause" : s.mode === "done" || s.mode === "auto" ? "wait" : s.phase,
      };
      if (s.mode === "auto") {
        // Отсчёт до автостарта — обычный ход «Таймера» тоном следующей фазы: свет — остаток, уходит справа налево (решение 9).
        // «До отдыха», а не «Отдых через»: длинное слово не входит в S, а точки раундов — в M (стенд, 25.11); точек в отсчёте нет.
        const np = nextPhase();
        card.tone = TONE[np];
        card.word = np === "focus" ? "До фокуса" : "До отдыха";
        card.endsAt = s.autoEnds;
        card.durSec = s.autoDur;
        card.rounds = 0;
        card.current = false;
      } else if (s.mode === "run") {
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
      ctx.cards.timer.set(card, { stalenessSec: 86400 });
      // Кнопка «Помодоро» (SDK 16): горит, пока фаза идёт; слова — что сейчас, подробность W — до какого часа.
      ctx.actions.toggle.state(s.mode === "run"
        ? { on: true, text: s.phase === "focus" ? "Фокус" : "Отдых", detail: "до " + hhmm(s.endsAt), glyph: "timer" }
        : { on: false, text: s.mode === "pause" ? "Пауза" : s.mode === "done" || s.mode === "auto" ? "Готово" : "Начать",
            glyph: "timer" });
      ctx.entities.setMany({
        phase: s.mode === "pause" ? "пауза" : s.mode === "done" || s.mode === "auto" ? "ждёт"
             : { ready: "готов", focus: "фокус", break: "отдых", long: "долгий" }[s.phase],
        left: s.mode === "run" ? remain(Date.now()) : s.mode === "pause" ? s.left : 0,
      });
      s.last = dayKey(Date.now());
      save();
    }

    // ---- ход ----
    function schedule() {
      if (timer) ctx.timers.clear(timer);
      if (ticker) ctx.timers.clear(ticker);
      timer = ticker = 0;
      if (s.mode === "auto") {
        timer = ctx.timers.setTimeout(() => { timer = 0; next(); }, Math.max(0, s.autoEnds - Date.now()));
        return;
      }
      if (s.mode === "done" && s.holdUntil) {
        timer = ctx.timers.setTimeout(() => { timer = 0; idle(); }, Math.max(0, s.holdUntil - Date.now()));
        return;
      }
      if (s.mode !== "run") return;
      timer = ctx.timers.setTimeout(() => { timer = 0; phaseEnd(false); }, Math.max(0, s.endsAt - Date.now()));
      // сущность «Осталось» идёт по секундам, как цифры прибора (ревью 24.11, находка 16: стояла на миге публикации)
      ticker = ctx.timers.setInterval(() => ctx.entities.setMany({ left: remain(Date.now()) }), 1000);
    }
    function run(phase, dur) {
      s.phase = phase;
      s.mode = "run";
      s.dur = dur;
      s.endsAt = Date.now() + dur * 1000;
      s.left = 0;
      s.holdUntil = 0;
      s.rest = phase !== "focus";          // экран отдыха — от начала отдыха до запуска фокуса (решение 14)
      schedule();
      publish();
      full(s.rest);                        // отдых — во весь экран; фокус сворачивает карточку в её место
    }
    const startFocus = () => run("focus", focusSec());
    const startBreak = () => {
      const long = s.done >= rounds();
      run(long ? "long" : "break", long ? longSec() : breakSec());
    };
    // «Начать»: после отдыха экран отдыха стоит (карточка во весь экран — до запуска фокуса), после сброса — свёрнута.
    function readyForFocus() {
      s.mode = "ready";
      s.phase = "ready";
      s.dur = focusSec();
      s.endsAt = 0;
      s.left = 0;
      s.holdUntil = 0;
      schedule();
      publish();
      if (!s.rest) full(false);
    }

    // Фаза дотикала (или её пропустили). late — кончилась, пока агента не было; silent — следующую фазу запустит вызвавший.
    function phaseEnd(late, silent) {
      // Кончилась давно (агента не было дольше LATE_MS — ПК выключали): тихо — «Начать», без автостарта и без экрана отдыха;
      // фокус засчитан днём своего конца (ревью 24.11, находка 4).
      const stale = late && Date.now() - s.endsAt > LATE_MS;
      if (s.phase === "focus") {
        s.done = Math.min(rounds(), s.done + 1);
        countFocus(s.dur, 1, stale ? s.endsAt : 0);
      } else if (s.phase === "long") {
        s.done = 0;                        // цикл пройден — следующий фокус первый
      }
      if (stale) {
        s.rest = false;
        readyForFocus();
        return;
      }
      const wasFocus = s.phase === "focus";
      s.mode = "done";
      s.left = 0;
      s.holdUntil = 0;
      if (silent) { schedule(); publish(); return; }
      const auto = wasFocus ? !!set("autoBreak") : !!set("autoFocus");
      if (!set("notify")) {
        // без «во весь экран»: автостарт сразу, иначе — ждёт (фокус после отдыха — «Начать»)
        schedule();
        publish();
        if (auto) next();
        else if (!wasFocus) readyForFocus();
        return;
      }
      if (auto) {
        // отсчёт до автостарта — в карточке во весь экран
        s.mode = "auto";
        s.autoDur = autoSec();
        s.autoEnds = Date.now() + s.autoDur * 1000;
      } else {
        s.holdUntil = Date.now() + holdSec() * 1000;   // без ответа: после фокуса — свернуть, после отдыха — «Начать»
      }
      schedule();
      publish();
      full(true);
    }

    // ---- действия ----
    function next() {
      if (s.phase === "focus") startBreak();
      else startFocus();
    }
    function toggle() {
      if (s.mode === "ready") startFocus();
      else if (s.mode === "run") {
        s.left = Math.max(1, remain(Date.now()));
        s.mode = "pause";
        schedule();
        publish();
      } else if (s.mode === "pause") {
        s.mode = "run";
        s.endsAt = Date.now() + s.left * 1000;
        schedule();
        publish();
      } else next();                         // «Готово» или отсчёт автостарта — следующая фаза сразу
    }
    // Плюс минуты: идущей или стоящей на паузе фазе — к концу; кончившейся — продолжение той же фазы (раунд фокуса снова
    // не засчитан, пока продолжение не кончится).
    function plus() {
      const add = plusSec();
      if (s.mode === "run") { s.endsAt += add * 1000; s.dur += add; schedule(); publish(); }
      else if (s.mode === "pause") { s.left += add; s.dur += add; publish(); }
      else if (s.mode === "done" || s.mode === "auto") more();
    }
    function more() {
      const add = plusSec();
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
      s.holdUntil = 0;
      s.rest = s.phase !== "focus";
      schedule();
      publish();
      full(s.rest);                          // ещё фокус — карточка в место; ещё отдых — во весь экран
    }
    function skip() {
      if (s.mode === "ready") return startFocus();
      if (s.mode === "done" || s.mode === "auto") return next();
      if (s.phase === "focus") {             // фокус засчитан тем, что прошло
        const gone = Math.max(0, s.dur - (s.mode === "run" ? remain(Date.now()) : s.left));
        s.dur = gone;
      }
      phaseEnd(false, true);
      next();
    }
    function reset() {
      s.done = 0;
      s.rest = false;
      readyForFocus();                       // свернёт карточку
    }
    // «Готово» без ответа (holdSec): после фокуса — карточка сворачивается и ждёт на месте; после отдыха — «Начать», экран
    // отдыха стоит до запуска фокуса.
    function idle() {
      s.holdUntil = 0;
      if (s.phase === "break" || s.phase === "long") { readyForFocus(); return; }
      schedule();
      publish();
      full(false);
    }

    // SDK 17: «включить» — запустить (или продолжить, или следующая фаза), «выключить» — пауза; уже так — ничего
    ctx.actions.toggle.on((ev) => {
      const running = s.mode === "run";
      if ((ev.desired === "on" && running) || (ev.desired === "off" && !running)) return;
      toggle();
    });
    ctx.actions.reset.on(() => { reset(); });
    ctx.actions.plus.on(() => { plus(); });
    ctx.actions.skip.on(() => { skip(); });

    ctx.entities.declare([
      { id: "phase", label: "Фаза", kind: "string", states: ["готов", "фокус", "отдых", "долгий", "ждёт", "пауза"] },
      { id: "left", label: "Осталось", kind: "number", unit: "с" },
    ]);

    // настройки: «Начать» берёт новую длину фокуса; «во весь экран» — сразу; прочее — со следующей фазы
    ctx.settings.onChange(() => {
      if (s.mode === "ready") s.dur = focusSec();
      publish();
      full(s.rest || s.mode === "auto" || (s.mode === "done" && s.holdUntil > 0));
    });
    // новый день — итог дня заново (раз в минуту, без смены фазы кадр не уходит)
    ctx.timers.setInterval(() => { if (s.last !== dayKey(Date.now())) publish(); }, 60000);

    // ---- после перезапуска агента ----
    const now = Date.now();
    if (s.mode === "run" && s.endsAt <= now) phaseEnd(true);
    else if (s.mode === "auto" && s.autoEnds <= now) {
      if (now - s.autoEnds > LATE_MS) { s.rest = false; readyForFocus(); }
      else next();
    } else {
      if (s.mode === "done" && s.holdUntil && s.holdUntil <= now) s.holdUntil = 1;   // срок вышел, пока агента не было
      if (s.mode === "ready") s.dur = focusSec();
      schedule();
      publish();
      full(s.rest || s.mode === "auto" || (s.mode === "done" && s.holdUntil > 0));
    }
  },
});
