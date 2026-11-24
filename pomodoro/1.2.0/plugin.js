// Помодоро (usee-timer-plan.md; решения владельца 23.11.2026): фокус → отдых (после последнего раунда — долгий) → снова
// фокус. Вид и ход секунд — у прибора: карточка «Таймер» (тип 18) получает конец фазы, секунды прибор считает сам по своим
// часам, кадр уходит только при смене состояния. Конец фазы — экран-уведомление во весь экран с круглыми кнопками
// (ctx.screen.notify): отдых начинается сам через autoSec, фокус — только касанием (по умолчанию). Экран отдыха — сцена
// плагина «Отдых» по is_on карточки: от начала отдыха до следующего запуска фокуса. Состояние переживает перезапуск агента
// (ctx.storage); итог дня — по местному времени ПК.

const TONE = { ready: "blue", focus: "red", break: "green", long: "violet" };
const LATE_MS = 10 * 60 * 1000;          // фаза кончилась, пока агента не было, давнее — без уведомления
const DAYS_KEPT = 14;                    // дней в итоге (на карточке — сегодня)

definePlugin({
  cards: {
    timer: {
      label: "Помодоро",
      type: "timer",
      // касание — старт или пауза; удержание (1 с с кольцом) — сброс; свайп вправо — плюс минуты, влево — пропустить фазу
      input: { tap: "toggle", hold: "reset", right: "plus", left: "skip" },
    },
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
    let timer = 0, ticker = 0;

    const save = () => ctx.storage.set("state", s);
    const pad = (n) => (n < 10 ? "0" : "") + n;
    const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
    const mmss = (sec) => Math.floor(sec / 60) + ":" + pad(sec % 60);
    const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    // Остаток идущей фазы, с, — ровно как на приборе: он показывает конец фазы (целая секунда вниз) минус целую секунду своих
    // часов, а часы сверены с ПК до доли секунды (ревью 24.11, находка 3). Пауза берёт его же — цифры не прыгают.
    const remain = (now) => Math.max(0, Math.floor(s.endsAt / 1000) - Math.floor(now / 1000));
    const duration = (sec) => {
      const m = Math.round(sec / 60);
      return m < 60 ? m + " мин" : Math.floor(m / 60) + " ч" + (m % 60 ? " " + (m % 60) : "");
    };

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
      ctx.cards.timer.set(card, { stalenessSec: 86400 });
      // Кнопка «Помодоро» (SDK 16): горит, пока фаза идёт; слова — что сейчас, подробность W — до какого часа.
      ctx.actions.toggle.state(s.mode === "run"
        ? { on: true, text: s.phase === "focus" ? "Фокус" : "Отдых", detail: "до " + hhmm(s.endsAt), glyph: "timer" }
        : { on: false, text: s.mode === "pause" ? "Пауза" : s.mode === "done" ? "Готово" : "Начать", glyph: "timer" });
      ctx.entities.setMany({
        phase: s.mode === "pause" ? "пауза" : s.mode === "done" ? "ждёт"
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
      if (s.mode !== "run") return;
      timer = ctx.timers.setTimeout(() => { timer = 0; phaseEnd(false); }, Math.max(0, s.endsAt - Date.now()));
      // сущность «Осталось» идёт по секундам, как цифры прибора (ревью 24.11, находка 16: стояла на миге публикации)
      ticker = ctx.timers.setInterval(() => ctx.entities.setMany({ left: remain(Date.now()) }), 1000);
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
      // Кончилась давно (агента не было дольше LATE_MS — ПК выключали): тихо — «Начать», без автостарта, без уведомления и
      // без экрана отдыха; фокус засчитан днём своего конца (ревью 24.11, находка 4: прежде утром сам стартовал отдых и
      // вставала сцена «Отдых», а вчерашний фокус ложился на сегодня).
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
      s.mode = "done";
      s.left = 0;
      schedule();
      publish();
      if (silent) return;
      const wasFocus = s.phase === "focus";
      if (!set("notify")) {
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
          // после последнего фокуса цикла — тоже «Фокус окончен»: долгий отдых видно по фиолетовому и точкам (макет timer-5)
          title: "Фокус окончен",
          value: mmss(long ? longSec() : breakSec()),
          word: "Отдых",
          rounds: n,
          done: s.done,
          buttons: [
            { text: plus, action: "more" },                     // ещё фокус
            { icon: "play", action: "next", primary: true },    // отдых
            { icon: "stop", action: "stop" },
          ],
          auto: auto ? { sec: autoSec } : undefined,
          hold: auto ? undefined : { sec: holdSec, action: "idle" },
        });
      } else {
        const auto = !!set("autoFocus");
        s.notice = ctx.screen.notify({
          tone: "red",
          title: "Отдых окончен",
          value: mmss(focusSec()),
          word: "Фокус",
          rounds: rounds(),
          done: s.done,
          buttons: [
            { text: plus, action: "more" },                     // ещё отдых
            { icon: "play", action: "next", primary: true },    // фокус
            { icon: "stop", action: "stop" },
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
        s.left = Math.max(1, remain(Date.now()));
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
        const gone = Math.max(0, s.dur - (s.mode === "run" ? remain(Date.now()) : s.left));
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

    // SDK 17: «включить» — запустить (или продолжить, или следующая фаза), «выключить» — пауза; уже так — ничего
    ctx.actions.toggle.on((ev) => {
      const running = s.mode === "run";
      if ((ev.desired === "on" && running) || (ev.desired === "off" && !running)) return;
      toggle();
    });
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
    // новый день — итог дня заново (раз в минуту, без смены фазы кадр не уходит)
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
