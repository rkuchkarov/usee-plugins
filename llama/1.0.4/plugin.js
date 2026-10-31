// LLAMA для Usee — скорость генерации, занятость контекста и токены с любого
// llama.cpp-совместимого сервера (llama-server и форки). Плагин только смотрит:
// ничего не запускает, не проксирует и логи сервера не читает. Один грант — net на
// адрес из настройки.
//
// Базовый контракт — ванильные поля /props и /slots (llama.cpp 0.4.1). Форматные
// особенности форков живут в таблице адаптеров ниже и только ДОБАВЛЯЮТ возможности:
// ванильные поля адаптер перекрывать не вправе. Без --metrics и без адаптера плагин
// деградирует (меньше карточек), а не падает.

const PROPS_MS = 60_000;    // /props: модель, слоты, потолок n_ctx, карта эндпоинтов — меняются редко
const METRICS_MS = 45_000;  // каждый скрейп /metrics сбрасывает окно средних на сервере — потому редко
const WINDOW = 5;           // окно скорости в тиках: 2–10 с при интервале 1–2 с
const CURVE_POINTS = 90;    // HISTORY_SIZE прошивки: столько точек вмещает кривая spark
const DETAIL_BYTES = 36;    // status.detail: буфер 40 Б; запас на случай многоточий
// usable текст = размер буфера − 1 (card_slots.h: CS_CAP = sizeof(field) − 1)
const LINE2_BYTES = 71, SPEED_BYTES = 19, ETA_BYTES = 11, FOOT_BYTES = 23;

const KEY_MSG = "сервер требует ключ — впиши API-ключ в настройки";
const SLOTS_MSG = "слоты закрыты: запускай llama-server со --slots";
const UNKNOWN_MSG = "метрики не распознаны";

// Имена Prometheus-счётчиков llama.cpp (ванильный текст /metrics).
const P_TOK = "llamacpp:tokens_predicted_total";
const P_TOK_S = "llamacpp:tokens_predicted_seconds_total";
const P_PROMPT = "llamacpp:prompt_tokens_total";
const P_CACHE = "llamacpp:prompt_tokens_cached_total";
const P_BUSY = "llamacpp:requests_processing";

// §12 ТЗ: буферы прошивки фиксированные, сверх — strlcpy молча режет, ошибки не
// будет. Считаем байты UTF-8, а не знаки: кириллица — 2 байта.
const enc = new TextEncoder();
function clip(s, maxBytes) {
  s = String(s == null ? "" : s);
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "", used = 0;
  for (const ch of s) {                       // по кодпоинтам — суррогатную пару не режем пополам
    const b = enc.encode(ch).length;
    if (used + b > maxBytes) break;
    out += ch; used += b;
  }
  return out;
}

// Первая строка, которая реально влезает: буфер режет молча, а строка
// короче честнее обрезанной.
function firstFit(list, maxBytes) {
  for (const s of list) if (enc.encode(s).length <= maxBytes) return s;
  return clip(list[list.length - 1], maxBytes);
}

// Честное число либо null («значения нет»). Ни NaN, ни «?? 0» в карточки и на шину.
function n(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// «5,4» — десятичная запятая, как в подписях ТЗ; дробный ноль не плодим.
function num(v, dp) {
  if (v === null) return "";
  const s = dp ? v.toFixed(dp).replace(/\.?0+$/, "") : String(Math.round(v));
  return s.replace(".", ",");
}

// «7,5 млн» — иначе итог с запуска не влезает в detail (см. DETAIL_BYTES).
function compact(v) {
  if (v === null) return "";
  if (v >= 1e6) return num(v / 1e6, 1) + " млн";
  if (v >= 1e3) return num(v / 1e3) + "к";
  return num(v);
}

// Prometheus-текст опознаётся по началу с «#». Метки {…} отбрасываем и складываем
// значения одного имени: у сервера счётчики идут по path/model.
function parseProm(text) {
  const v = {};
  for (const raw of String(text == null ? "" : text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.search(/\s/);
    if (sp < 0) continue;
    const key = line.slice(0, sp).split("{")[0];
    const val = n(Number(line.slice(sp + 1).trim().split(/\s/)[0]));
    if (val !== null) v[key] = (v[key] || 0) + val;
  }
  return v;
}

// Плоская карта «имя поля → числа» из JSON. Адаптер опознаётся по ИМЕНАМ, а не по
// устройству продукта (ТЗ §4.2): новый форк — это строка таблицы, не новая сборка.
function flatNames(o, out, depth, maxDepth) {
  out = out || {};
  depth = depth || 0;
  if (o === null || typeof o !== "object" || depth > (maxDepth === undefined ? 4 : maxDepth)) return out;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) { if (!out[k]) out[k] = []; out[k].push(v); }
    else if (v !== null && typeof v === "object") flatNames(v, out, depth + 1, maxDepth);
  }
  return out;
}

// Имена полей ответа (не значения) — по ним узнаём формат. По значениям узнавать
// нельзя: у форка во время простоя полускорости и счётчики равны null, и адаптер
// исчезал бы между тиками.
function keyNames(o, out, depth, maxDepth) {
  out = out || {};
  depth = depth || 0;
  if (o === null || typeof o !== "object" || depth > maxDepth) return out;
  for (const k of Object.keys(o)) {
    out[k] = true;
    if (depth < maxDepth) keyNames(o[k], out, depth + 1, maxDepth);
  }
  return out;
}

// Адаптеры формата /metrics у форков — НЕ СТАНДАРТ. Только добавляют возможности
// (токены, скорость, потолок контекста) и помечены видимым источником в статусе;
// отключаются настройкой forkMetrics. Первый — Strata-подобная питон-прослойка.
const FORK_ADAPTERS = [
  {
    name: "strata",
    // имена, которые есть в ответе при любом состоянии сервера
    mark: ["hardware_static", "prefill_tok_s_mean"],
    read(j, sc) {
      const max = (a) => (a && a.length ? Math.max.apply(null, a) : null);
      const req0 = Array.isArray(j.requests) ? j.requests[0] : null;   // последний запрос
      return {
        // живая скорость — то же число, что показывает монитор форка во время
        // генерации (live.tok_s), а не средняя за запрос
        tokS: n(j.live && j.live.tok_s) ?? max(sc.tok_s),
        // средняя за уже завершённый запрос — тот же «at X tok/s», что монитор
        // показывает по последнему запросу. Поле берём явным путём, а не из карты
        // имён: рекорды запросов не должны становиться текущими числами (§4.2).
        decode: n(req0 && req0.decode_tok_s),
        // фаза «сервер читает промпт»: у Страты это её же live.state == "reading"
        // (ona сама выставляет progress чтения)
        reading: j.live && j.live.state === "reading" ? 1 : 0,
        // живой счётчик токенов форка; если он не вынесен на верхний уровень,
        // придумывать его по summed-полю запросов не будем
        gen: n(j.live && j.live.generated) ?? max(sc.generated),
        ctxMax: n(j.engine && j.engine.max_context) ?? max(sc.max_context) ?? max(sc.context),
      };
    },
  },
];

// Что вернул /metrics: Prometheus, адаптер форка или null («не распознано» — это не
// ошибка сервера, это отсутствие возможности).
function readMetrics(text, mode) {
  const t = String(text == null ? "" : text).replace(/^\s+/, "");
  if (t.startsWith("#")) return { kind: "prom", name: "prom", v: parseProm(t) };
  if (t.startsWith("{") && mode !== "prometheus") {
    let j = null;
    try { j = JSON.parse(t); } catch (e) { return null; }
    if (j === null || typeof j !== "object") return null;
    // значения берём только с верхних уровней: максимум по всему телю выдал бы
    // любой рекорд из истории запросов как текущее число
    const sc = flatNames(j, {}, 0, 1);
    const keys = keyNames(j, {}, 0, 2);
    for (const a of FORK_ADAPTERS) {
      if (!a.mark.every((k) => keys[k])) continue;
      return { kind: "fork", name: a.name, v: a.read(j, sc) };
    }
  }
  return null;
}

// Слот берём так: генерирующий, иначе — с максимальной занятостью (ТЗ §4).
// Остальные игнорируем, но их число человек видит в строке статуса.
function pickSlot(slots) {
  let best = null;
  for (const s of slots || []) {
    if (s === null || typeof s !== "object") continue;
    if (!best) { best = s; continue; }
    const nowBusy = s.is_processing === true, bestBusy = best.is_processing === true;
    if (nowBusy !== bestBusy) { if (nowBusy) best = s; continue; }
    if ((n(s.n_prompt_tokens) || -1) > (n(best.n_prompt_tokens) || -1)) best = s;
  }
  return best;
}

definePlugin({
  cards: {
    speed: { label: "LLAMA · скорость", type: "spark" },
    context: { label: "LLAMA · контекст", type: "gauge" },
    gen: { label: "LLAMA · генерация", type: "progress" },
    state: { label: "LLAMA · состояние", type: "status" },
  },

  activate(ctx) {
    // §6 ТЗ: объявляем всё, что умеем (объявление — строка в каталоге, ничего не
    // стоит); значения гоним только по спросу. `states` — НАШИ названия состояний,
    // мы сами строим их из is_processing, поэтому перечень и известен.
    ctx.entities.declare([
      { id: "tok_s", label: "LLAMA · ток/с", kind: "number", unit: "ток/с", precision: 0 },
      { id: "context_used", label: "LLAMA · контекст занят", kind: "number", unit: "ток", precision: 0 },
      { id: "context_size", label: "LLAMA · контекст всего", kind: "number", unit: "ток", precision: 0 },
      { id: "tokens_generated", label: "LLAMA · токенов в генерации", kind: "number", unit: "ток", precision: 0 },
      { id: "tokens_total", label: "LLAMA · токенов с запуска", kind: "number", unit: "ток", precision: 0 },
      { id: "cache_hit", label: "LLAMA · попадание в кэш", kind: "number", unit: "%", precision: 0 },
      { id: "state", label: "LLAMA · состояние", kind: "string",
        states: ["ожидает", "читает запрос", "генерирует", "нет связи"] },
      { id: "busy", label: "LLAMA · генерирует", kind: "bool" },
    ]);
    ctx.entities.onDemandChanged(() => publish());

    const OPT = { stalenessSec: 3600 };   // в простое карточки держат прошлое, а не гаснут (§5)

    let props = null, propsAt = 0;                    // /props: модель, слоты, потолок, карта эндпоинтов
    let metrics = null, metricsAt = 0;                // {kind:"prom"|"fork", name, v} — что дал /metrics
    let promPrev = null, promBase = 0, promAvg = null; // дельты Prometheus: средняя за завершённый запрос
    let samples = [];                                 // окно [t, счётчик] для скорости
    let prevCounter = null, prevPrompt = null;
    let genAt = 0, wasBusy = false, lastTokS = null, last = null;   // last — последняя завершённая генерация
    let srcLabel = "";                                // «метрики: …»; смену источника — в лог один раз
    let sem = readSem();                              // чем является n_prompt_tokens (ТЗ §4.3)
    let pendingEnd = false, endSec = null, promSeq = 0, endSeq = 0;          // итог запроса ещё не виден: ждём скрейпа /metrics
    let scrapeSeq = 0, forkEnd = false, forkEndSeq = 0;                      // то же для своей средней за запрос у форка
    let epMap = "";                                   // строка карты эндпоинтов: её смену — в лог
    let bus = {};                                     // значения сущностей этого тика

    function readSem() {
      const v = ctx.storage.get("promptSemantics");
      return v && typeof v === "object" && (v.kind === "ctx" || v.kind === "prompt") ? v : null;
    }

    function publish() {
      const want = ctx.entities.demanded();
      if (!want.length) return;                 // никто не потребляет — и трафика нет
      const v = {};
      for (const raw of want) {
        const id = String(raw);
        v[id] = Object.prototype.hasOwnProperty.call(bus, id) ? bus[id] : null;
      }
      ctx.entities.setMany(v);
    }

    // Δ счётчика / Δt по окну в WINDOW тиков. Счётчик откатился назад (новый запрос
    // в /slots или рестарт сервера) — окно пересобираем с нуля (§4).
    function windowSpeed(t, counter) {
      const prev = samples[samples.length - 1];
      if (prev && (counter < prev[1] || t <= prev[0])) samples = [];
      // Счётчик за тик не шевельнулся (прелиф, длинный промпт) — измерения скорости
      // нет: окно остаётся, а скорость возвращаем null, чтобы держалось последнее
      // число, а не сползало к нулю по мере выхода старых точек из окна.
      const stalled = prev !== undefined && counter === prev[1];
      samples.push([t, counter]);
      if (samples.length > WINDOW) samples = samples.slice(samples.length - WINDOW);
      const a = samples[0], b = samples[samples.length - 1];
      const dt = (b[0] - a[0]) / 1000;
      if (stalled || samples.length < 2 || dt <= 0) return null;
      return Math.max(0, (b[1] - a[1]) / dt);
    }

    // Итоги с запуска даёт только /metrics — у gauge футера нет, строка едет в
    // четвёртую строку status-карточки (буфер 40 Б, формат один).
    function detailLine() {
      const tot = metrics && metrics.kind === "prom" ? n(metrics.v[P_TOK]) : null;
      return tot === null ? null : clip("с запуска " + compact(tot) + " ток", DETAIL_BYTES);
    }

    function totals() {
      if (metrics && metrics.kind === "prom") {
        const tot = n(metrics.v[P_TOK]);
        // prompt_tokens_total считает только обработанные токены: кэш в него
        // не входит (HELP в llama.cpp server-task.cpp:1526-1532) — знаменатель сумма.
        const prompt = n(metrics.v[P_PROMPT]), cached = n(metrics.v[P_CACHE]);
        const all = (prompt || 0) + (cached || 0);
        return { total: tot, cache: cached !== null && all > 0 ? (100 * cached) / all : null };
      }
      // чужие итоги не трактуем: у форков «prompt_tokens» то включает кэш, то нет
      if (metrics && metrics.kind === "fork") return { total: null, cache: null };
      return { total: null, cache: null };
    }

    function statusCard(name, busyNow) {
      const s = { icon: "bolt", line1: "LLAMA", state: name, is_on: busyNow };
      if (props && props.alias) s.line2 = clip(props.alias, LINE2_BYTES);      // псевдоним модели
      s.badge = name === "генерирует" ? "ГЕНЕРИТ"
        : name === "читает запрос" ? "ЧТАЕТ"
        : name === "нет связи" ? "ОБРЫВ"
        : props && props.sleeping ? "СОН" : "ПРОСТОЙ";                 // §12: «ГЕНЕРИРУЕТ» и «НЕТ СВЯЗИ» в буфер не влезают
      s.badgeKind = name === "нет связи" ? "rec" : busyNow ? "accent" : "plain";
      if (last && last.at) s.eventAt = last.at;                       // «2 МИН НАЗАД» рисует устройство
      const d = detailLine();
      if (d) s.detail = d;
      ctx.cards.state.set(s, OPT);
    }

    async function tick() {
      const addr = String(ctx.settings.get("addr") || "").trim().replace(/\/+$/, "");
      if (!addr) throw new Error("не задан адрес сервера (host:port)");
      const origin = /^https?:\/\//i.test(addr) ? addr : "http://" + addr;
      const key = String(ctx.settings.get("apiKey") || "").trim();
      const mode = String(ctx.settings.get("forkMetrics") || "auto");
      const intervalSec = Math.max(1, n(ctx.settings.get("intervalSec")) || 2);
      // Bearer шлём только когда ключ непустой: пустой заголовок сервер читает как «ключа нет».
      const init = key ? { headers: { Authorization: "Bearer " + key } } : undefined;
      const warn = [];
      const now = Date.now();

      // Тело читаем через text(): у глобального fetch и text, и json — МЕТОДЫ,
      // возвращающие Promise, а json() к тому же реджектится на нераспознанном
      // JSON. Prometheus так и вообще не JSON, поэтому нюхаем текст.
      const body = async (r) => { try { return await r.text(); } catch { return ""; } };
      const jsonOf = (t) => { try { return JSON.parse(t); } catch { return null; } };

      const get = async (path) => {
        let r;
        try { r = await fetch(origin + path, init); }
        catch (e) {
          // fetch реджектится строкой-причиной («адрес не найден», таймаут) — без неё
          // человек не поймёт, сервер лежит или адрес вписан криво.
          const err = new Error("llama-server не отвечает на " + addr + (e ? " — " + String(e) : ""));
          err.offline = true;
          throw err;
        }
        if (r.status === 401 || r.status === 403) throw new Error(KEY_MSG);
        return r;
      };

      // ---- /props: раз в 60 с (и сразу после неудачи) ----
      if (now - propsAt >= PROPS_MS) {
        propsAt = now;
        const r = await get("/props");
        if (r.ok) {
          const p = jsonOf(await body(r)) || {};
          props = {
            alias: typeof p.model_alias === "string" ? p.model_alias : null,
            totalSlots: n(p.total_slots),
            // потолок слота; в роутер-режиме своего набора полей нет — тогда только из слота
            ctxMax: n(p.default_generation_settings && p.default_generation_settings.n_ctx),
            slotsOn: p.endpoint_slots !== false,
            metricsOn: p.endpoint_metrics !== false,
            propsOn: p.endpoint_props !== false,
            sleeping: p.is_sleeping === true,
          };
          // поле n_prompt_tokens принадлежит сборке, а не стандарту: смена модели —
          // вывод больше не гарантирован, перепроверяем (§4.3)
          if (sem && sem.alias !== props.alias) {
            sem = null;
            ctx.storage.delete("promptSemantics");
          }
          // карту эндпоинтов пишем один раз на её смену: по ней видно, что сервер
          // умеет (endpoint_props — не GET, а запись настроек; в роутер-режиме
          // набор полей свой, и потолок n_ctx тогда только из слота).
          const map = (props.slotsOn ? "слоты" : "слоты закрыты") + ", " +
                      (props.metricsOn ? "метрики" : "метрики закрыты") + ", " +
                      (props.propsOn ? "props" : "props только чтение");
          if (map !== epMap) { ctx.log.info("сервер «" + (props.alias || "?") + "»: " + map); epMap = map; }
        } else {
          propsAt = 0;                                       // серии ошибок — следующий тик тянет /props снова
          if (r.status !== 501) warn.push("/props: HTTP " + r.status);
        }
      }

      // ---- /slots: каждый тик ----
      let slots = null;
      if (props && props.slotsOn === false) warn.push(SLOTS_MSG);
      else {
        const r = await get("/slots");
        if (r.status === 501) warn.push(SLOTS_MSG);          // --no-slots: дальше только /metrics
        else if (!r.ok) warn.push("/slots: HTTP " + r.status);
        else { const j = jsonOf(await body(r)); slots = Array.isArray(j) ? j : []; }  // ответ — МАССИВ слотов
      }
      const slot = pickSlot(slots);

      // ---- /metrics: Prometheus — редко (каждый скрейп сбрасывает на сервере окно
      // средних), JSON форка — каждый тик: он просто читает состояние сервера, а при
      // редкой съёмке его живые числа устарели бы на целую минуту. Отдельная съёмка —
      // сразу после конца запроса. ----
      const scarce = metrics && metrics.kind === "fork" ? 0 : METRICS_MS;
      if (mode !== "off" && (!props || props.metricsOn !== false) && now - metricsAt >= scarce) {
        metricsAt = now;
        const r = await get("/metrics");
        if (r.status === 501) metrics = null;                // итогов нет — и это не ошибка (§8)
        else if (!r.ok) warn.push("/metrics: HTTP " + r.status);
        else {
          metrics = readMetrics(await body(r), mode);
          if (metrics) scrapeSeq++;               // номер съёмки: по нему видим, что итог свежее конца запроса
          if (!metrics) { warn.push(UNKNOWN_MSG); promPrev = null; }
          else if (metrics.kind === "prom") {
            const cur = metrics.v, dToks = promPrev ? (n(cur[P_TOK]) || 0) - (n(promPrev[P_TOK]) || 0) : null;
            const dSecs = promPrev ? (n(cur[P_TOK_S]) || 0) - (n(promPrev[P_TOK_S]) || 0) : null;
            // средняя за завершённый запрос: счётчики предсказания сервер пишет в
            // конце запроса, поэтому дельта появляется только после его конца (§2 п.1)
            promAvg = dToks !== null && dToks > 0 && dSecs !== null && dSecs > 0 ? dToks / dSecs : null;
            promPrev = cur;
            promSeq++;
          } else promPrev = null;
        }
      }

      const prom = metrics && metrics.kind === "prom" ? metrics.v : null;
      const fork = metrics && metrics.kind === "fork" ? metrics.v : null;
      const busy = slot ? slot.is_processing === true : (n(prom && prom[P_BUSY]) || 0) > 0;

      // Границы генерации: окно скорости и точка отсчёта Prometheus-дельты — у
      // запроса свои, тащить их через границу означало бы выдуманные числа.
      if (busy && !wasBusy) {
        samples = [];
        genAt = now;
        pendingEnd = false;
        promBase = n(prom && prom[P_TOK]) ?? promBase;
        promAvg = null;
      }

      // ---- ступень 1→5 (§4.1): берём ПЕРВЫЙ доступный счётчик токенов ----
      const nt = Array.isArray(slot && slot.next_token) ? slot.next_token[0] : null;
      let counter = n(nt && nt.n_decoded), csrc = counter !== null ? "slots" : "";
      const remain = n(nt && nt.n_remain);
      // лимит = n_decoded + n_remain; n_remain = −1 значит «лимита нет» (§2 п.3)
      let limit = counter !== null && remain !== null && remain >= 1 ? counter + remain : null;
      if (counter === null && fork) { counter = fork.gen; csrc = counter !== null ? "fork" : ""; }
      if (counter === null && !busy && prom && n(prom[P_TOK]) !== null) {
        // Prometheus-счётчик предсказания сервер дописывает только в конце
        // запроса (server-context.cpp:4129-4137): живых токенов он не даёт, это
        // итог уже завершённого запроса, а не текущей генерации
        counter = Math.max(0, (n(prom[P_TOK]) || 0) - promBase);
        csrc = "prom";
      }
      // без счётчика скорость не выдумываем: оценка по Δ n_prompt_tokens на живом
      // замере дала бы 0 при 563 сгенерированных токенах (§4.1). Генерация идёт, а
      // счётчика нет — окно уже сброшено выше, человеку говорим прямо.
      // фаза чтения промпта: счётчик токенов ещё не появился, но он появится — это
      // НЕ «счётчика нет вообще» (§4.1 шаг 5). У ванили берём только явный случай
      // (ничего не обработано): при части обработанных токенов не отличить от
      // генерации, а выдумывать фазу нельзя.
      const reading = busy && counter === null &&
        ((fork !== null && n(fork.reading) === 1) || n(slot && slot.n_prompt_tokens_processed) === 0);

      if (busy && counter === null) warn.push(reading ? "читает промпт" : "токены не видны");

      let tokS = null, fresh = false;
      if (busy && counter !== null) {
        const w = windowSpeed(now, counter);
        fresh = w !== null && w > 0;
        if (fresh) lastTokS = w;
        tokS = fresh ? w : lastTokS;      // измерения нет — показываем последнюю скорость
      } else samples = [];
      // фаза чтения промпта у форка: измерение скорости этого запроса уже было, так
      // что число держим (кривая при этом молчит: fresh не ставим). Если же счётчика
      // в этом формате нет вообще — числа выдумывать нельзя, оно остаётся пустым.
      if (reading && tokS === null) tokS = lastTokS;
      // Счётчик адаптера меняется только вместе со скрейпом /metrics, своя дельта по
      // нему за окно не вырастает. У таких форков скорость берём у сервера (своё
      // числовое поле скорости), а не выдумываем из редкой дельты.
      if (csrc === "fork" && fork) {
        const f = n(fork.tokS);
        if (f !== null && f > 0) { tokS = f; lastTokS = f; fresh = true; }
        else tokS = lastTokS;            // сервер свою скорость во время прелифа не даёт
      }

      if (wasBusy && !busy) {
        endSec = genAt ? (now - genAt) / 1000 : null;
        // счётчик был слепой (только Prometheus) — итог придёт со следующего скрейпа
        if (prevCounter === null) { pendingEnd = true; endSeq = promSeq; }
        else last = {                                            // в простое карточки показывают ЭТО, а не прочерк
          toks: prevCounter,
          tokS: promAvg !== null ? promAvg : lastTokS,      // средняя сервера честнее нашей дельты, но появляется позже конца запроса
          sec: genAt ? (now - genAt) / 1000 : null,
          at: Math.floor(now / 1000),
        };
        // у форка своя средняя за запрос появляется только когда запрос вправду
        // закончился — ждём съёмку, идущую за этим тиком
        if (fork) { forkEnd = true; forkEndSeq = scrapeSeq; }
        // и среднюю за запрос, и его итог сервер выдаёт только после конца запроса
        if (mode !== "off" && (!props || props.metricsOn !== false)) metricsAt = 0;
      }

      // ---- §4.3: чем является n_prompt_tokens в этой сборке ----
      const prompt = n(slot && slot.n_prompt_tokens);
      const live = csrc === "slots" || csrc === "fork";     // счётчик двигается вместе с генерацией
      if (busy && live && prompt !== null && prevPrompt !== null && prevCounter !== null && counter !== null) {
        const dP = prompt - prevPrompt, dC = counter - prevCounter;
        const kind = dP > 0 && dC > 0 ? "ctx" : dP === 0 && dC > 0 ? "prompt" : null;
        if (kind && (!sem || sem.kind !== kind || sem.alias !== (props && props.alias) )) {
          sem = { alias: props ? props.alias : null, kind };
          ctx.storage.set("promptSemantics", sem);
        }
      }
      prevPrompt = prompt;

      // итог запроса от Prometheus приходит на тик позже самого конца запроса
      if (pendingEnd && !busy && counter !== null && promSeq !== endSeq) {
        last = { toks: counter, tokS: promAvg !== null ? promAvg : lastTokS,
                 sec: endSec, at: Math.floor(now / 1000) };
        pendingEnd = false;
      }
      // та же история у форка: свою среднюю за запрос он выставляет только что
      // завершённом запросе, берём её из съёмки, пришедшей после конца
      if (forkEnd && !busy && fork && n(fork.decode) !== null && scrapeSeq !== forkEndSeq) {
        if (last) last = { toks: last.toks, tokS: n(fork.decode), sec: endSec, at: last.at };
        forkEnd = false;
      }

      // Занятость KV: в ванили n_prompt_tokens УЖЕ включает сэмплированные токены;
      // если поле стоит на месте при растущем счётчике — оно промпт-ориентированное,
      // и тогда плюсует счётчик генерации.
      const used = prompt === null ? null : prompt + (sem && sem.kind === "prompt" ? Math.max(0, counter || 0) : 0);
      // потолок: ванильные поля главнее адаптера — тот только добавляет
      const size = n(slot && slot.n_ctx) ?? (props ? props.ctxMax : null) ?? (fork ? fork.ctxMax : null);
      const shownToks = busy ? counter : last ? last.toks : counter;
      const shownSpeed = busy ? tokS : last ? last.tokS : null;
      const shownSec = busy ? (genAt ? (now - genAt) / 1000 : null) : last ? last.sec : null;

      // ---- карточки (§5) ----
      if (shownSpeed !== null) {
        const v = Math.round(shownSpeed);
        ctx.cards.speed.set({ label: "ГЕНЕРАЦИЯ", number: v, unit: "ток/с",
                              windowSec: CURVE_POINTS * intervalSec, state: String(v) }, OPT);
        // Точка в кривую — САМО значение, а не высота графика: прошивка принимает
        // точку spark как текущее число карточки (src/cards.h: cardHistPush →
        // `spark.cur = point`), а масштаб графика подбирает сама по точкам
        // (renderer_cards/spark.inc). Нормировка в 0..255 показала бы на экране
        // высоту: 255 на каждом пике. Точка — байт: при скорости выше 255 ток/с
        // кривая встаёт, а число карточки, статус и llama.tok_s остаются настоящими.
        // В простое точки не идут вовсе: каждая точка HIST обнуляет число карточки
        // (тот же `spark.cur = point`), то есть «ноль в кривой» на экране означал бы
        // «ноль скорости». Кривая последней генерации остаётся как есть.
        if (busy && fresh && v <= 255) ctx.cards.speed.history(v);
      }

      if (used !== null || size !== null) {
        // gauge `number` на приборе — целое i16 (src/cards.h): 68 984 ток он покажет
        // как 3 448, а 102 405 — как минус. Поэтому от 1000 токены едут тысячами
        // («69» + «к ток»); разрядка шкалы делится на ту же тысячу, заливка та же.
        const k = used !== null && used >= 1000 ? 1000 : 1;
        const g = { label: "КОНТЕКСТ", unit: k === 1000 ? "к ток" : "ток",
                    number: used === null ? undefined : used / k,
                    state: used === null ? undefined : String(Math.round(used)) };
        if (used !== null && size !== null) { g.min = 0; g.max = size / k; }
        ctx.cards.context.set(g, OPT);
      }

      if (shownToks !== null) {
        const p = { title: "ГЕНЕРАЦИЯ", titleShort: "ГЕНЕР",
                    state: String(shownToks) };
        if (busy) {
          if (limit !== null) p.pct = Math.round(Math.min(100, (100 * shownToks) / limit));
          else p.indeterminate = true;                     // лимита нет (n_remain = −1) или он не виден вовсе
        } else p.pct = 100;                                 // запрос завершён: полоса полная, даже когда лимита не видели
        if (shownSpeed !== null) p.speed = clip(num(shownSpeed) + " ток/с", SPEED_BYTES);
        if (busy && limit !== null && shownSpeed !== null && shownSpeed > 0) {
          p.eta = clip("≈" + Math.max(0, Math.ceil((limit - shownToks) / shownSpeed)) + " с", ETA_BYTES);
        }
        const dur = shownSec !== null ? " · " + num(shownSec, 1) + " с" : "";
        p.foot = firstFit([num(shownToks) + " ток" + dur, compact(shownToks) + " ток" + dur,
                           num(shownToks) + " ток", compact(shownToks) + " ток"], FOOT_BYTES);
        if (!busy) p.done = true;
        ctx.cards.gen.set(p, OPT);
      }

      const proc = n(slot && slot.n_prompt_tokens_processed);
      const stName = props && props.sleeping ? "ожидает"
        : busy ? (proc !== null && prompt !== null && proc < prompt ? "читает запрос" : "генерирует")
        : "ожидает";
      statusCard(stName, busy);

      const tot = totals();
      bus = {
        tok_s: shownSpeed === null ? null : Math.round(shownSpeed),
        context_used: used, context_size: size, tokens_generated: shownToks,
        tokens_total: tot.total, cache_hit: tot.cache === null ? null : Math.round(tot.cache),
        state: stName, busy: busy,
      };
      publish();

      // ---- строка статуса: факты и всегда — подпись источника метрик (§11.1) ----
      const src = metrics ? (metrics.kind === "prom" ? "метрики: Prometheus"
        : "метрики: адаптер «" + metrics.name + "» (не стандарт)") : "метрик нет";
      if (src !== srcLabel) {
        if (srcLabel) ctx.log.info("смена источника метрик: " + srcLabel + " → " + src);
        srcLabel = src;
      }
      if (mode === "off" && csrc !== "slots") warn.push("/metrics выключен настройкой");
      const bits = [];
      if (slot && slots && slots.length > 1) bits.push("слотов " + slots.length + ", беру #" + (n(slot.id) || 0));
      else if (slot) bits.push("слот #" + (n(slot.id) || 0));
      if (used !== null && size !== null) bits.push(compact(used) + "/" + compact(size) + " ток");
      if (shownSpeed !== null) bits.push(Math.round(shownSpeed) + " ток/с");
      bits.push(src);                     // §11.1: чем закончилась строка, видно всегда
      if (warn.length) ctx.status.set("warn", warn.concat(bits).join(" · "));
      else ctx.status.set("ok", bits.join(" · "));

      prevCounter = counter;
      wasBusy = busy;
    }

    ctx.poll(async () => {
      try { await tick(); }
      catch (e) {
        // причину говорит плагин: «не отвечает на <адрес>», «требует ключ» — человек
        // видит её в списке плагинов (после серии неудач /props тянем снова)
        const why = e && (e.message || e.offline) ? String(e.message || e) : String(e);
        if (e && e.offline) {
          // сервера нет: карточки держат последние значения, правду о связи несут
          // бейдж и сущности (§8)
          statusCard("нет связи", false);
          bus.state = "нет связи";
          bus.busy = false;
          publish();
        }
        propsAt = 0;
        metricsAt = 0;
        ctx.status.set("error", why);
      }
    }, { everySetting: "intervalSec" });
  },
});
