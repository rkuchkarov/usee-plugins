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
// Ёмкости полей прибора знает хост (SDK 11): тексты — строкой или вариантами от
// длинного к короткому; своя таблица байтов и своя обрезка сняты (1.1.0).

const KEY_MSG = "сервер требует ключ — впиши API-ключ в настройки";
const SLOTS_MSG = "слоты закрыты: запускай llama-server со --slots";
const UNKNOWN_MSG = "метрики не распознаны";

// Имена Prometheus-счётчиков llama.cpp (ванильный текст /metrics).
const P_TOK = "llamacpp:tokens_predicted_total";
const P_TOK_S = "llamacpp:tokens_predicted_seconds_total";
const P_PROMPT = "llamacpp:prompt_tokens_total";
const P_CACHE = "llamacpp:prompt_tokens_cached_total";
const P_BUSY = "llamacpp:requests_processing";

// Честное число либо null («значения нет»). Ни NaN, ни «?? 0» в карточки и на шину.
function n(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// «5,4» — десятичная запятая, как в подписях ТЗ; дробный ноль не плодим.
function num(v, dp) {
  if (v === null) return "";
  const s = dp ? v.toFixed(dp).replace(/\.?0+$/, "") : String(Math.round(v));
  return s.replace(".", ",");
}

// «7,5 млн» — иначе итог с запуска не влезает в detail (39 байт прибора). Порог «млн»
// по значению, а не по округлённым тысячам: 999 999 дал бы «1000к».
function compact(v) {
  if (v === null) return "";
  if (v >= 999_500) return num(v / 1e6, 1) + " млн";
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
    // имён первых непривычных полей (§4.2): по ним видно, чем именно формат не подошёл
    return { kind: "unknown", name: "unknown", keys: Object.keys(keys).slice(0, 4) };
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
      { id: "tok_s", label: "LLAMA · ток/с", kind: "number", unit: "т/с", precision: 0 },
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
    let promSpan = false;                              // начало запроса видели: дельта ему и принадлежит
    let promEnd = false, promEndSeq = 0;               // среднюю за запрос ждём со съёмки после конца
    let samples = [];                                 // окно [t, счётчик] для скорости
    let prevCounter = null, prevPrompt = null;
    let genAt = 0, wasBusy = null, lastTokS = null, last = null;   // last — последняя завершённая генерация
    // база точки кривой: счётчик и момент последней выставленной точки (ряд идёт тик-в-тик)
    let pointAt = 0, pointBase = null;
    let srcLabel = "";                                // «метрики: …»; смену источника — в лог один раз
    let sem = readSem();                              // чем является n_prompt_tokens (ТЗ §4.3)
    let pendingEnd = false, endSec = null, promSeq = 0, endSeq = 0;          // итог запроса ещё не виден: ждём скрейпа /metrics
    let scrapeSeq = 0, forkEnd = false, forkEndSeq = 0;                      // то же для своей средней за запрос у форка
    let epMap = "";                                   // строка карты эндпоинтов: её смену — в лог
    let model = readModel();                          // алиас и потолок n_ctx с последней удачной /props
    let bus = {};                                     // значения сущностей этого тика

    function readSem() {
      const v = ctx.storage.get("promptSemantics");
      return v && typeof v === "object" && (v.kind === "ctx" || v.kind === "prompt") ? v : null;
    }

    // алиас модели и потолок n_ctx (§4: /props кладётся в ctx.storage): при
    // недоступном сервере карточка остаётся с моделью и шкалой, а не пустой
    function readModel() {
      const v = ctx.storage.get("model");
      if (!v || typeof v !== "object") return null;
      return { alias: typeof v.alias === "string" ? v.alias : null,
               ctxMax: typeof v.ctxMax === "number" ? v.ctxMax : null };
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
      return tot === null ? null : ["с запуска " + compact(tot) + " ток", compact(tot) + " ток"];
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
      if (props && props.alias) s.line2 = props.alias;      // псевдоним модели
      else if (!props && model && model.alias) s.line2 = model.alias;  // /props в этом запуске ещё не отвечала: помним модель
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
          if (!model || model.alias !== (props.alias || null) || model.ctxMax !== (props.ctxMax ?? null)) {
            model = { alias: props.alias || null, ctxMax: props.ctxMax ?? null };
            ctx.storage.set("model", model);
          }
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
        else { const j = jsonOf(await body(r));
               if (Array.isArray(j)) slots = j;
               else warn.push("/slots: ответ не массив"); }   // страница прокси или объект-ошибка —
      }                                                        // это не «слотов нет», молчать нельзя
      const slot = pickSlot(slots);
      const prompt = n(slot && slot.n_prompt_tokens);

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
          if (!metrics || metrics.kind === "unknown") {
            const names = metrics && metrics.keys ? metrics.keys.join(", ") : "";
            warn.push(UNKNOWN_MSG + (names ? ": " + names : ""));
            metrics = null; promPrev = null;            // нераспознанное тело чисел не даёт
          }
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
        promEnd = false;
        pointBase = null;                             // база дельты — со старта этого запроса
        // точка отсчёта дельты — счётчик на старте запроса; если тела /metrics в этом
        // тике не было, дельту этому запросу не атрибутировать: вышла бы итоговая
        // цифра за всю жизнь сервера
        const pbase = prom ? n(prom[P_TOK]) : null;
        promBase = pbase !== null ? pbase : promBase;
        // если запрос уже шёл к нашему первому тике — база снята внутри него: сервер
        // дописывает счётчик только на конце (server-context.cpp:4129-4137), в ней ещё и прошлые итоги
        promSpan = pbase !== null;
        promAvg = null;
      }

      // ---- ступень 1→5 (§4.1): берём ПЕРВЫЙ доступный счётчик токенов ----
      const nt = Array.isArray(slot && slot.next_token) ? slot.next_token[0] : null;
      let counter = n(nt && nt.n_decoded), csrc = counter !== null ? "slots" : "";
      const remain = n(nt && nt.n_remain);
      // лимит = n_decoded + n_remain; n_remain = −1 значит «лимита нет» (§2 п.3)
      let limit = counter !== null && remain !== null && remain >= 1 ? counter + remain : null;
      if (counter === null && fork) { counter = fork.gen; csrc = counter !== null ? "fork" : ""; }
      if (counter === null && !busy && promSpan && prom && n(prom[P_TOK]) !== null) {
        // Prometheus-счётчик предсказания сервер дописывает только в конце
        // запроса (server-context.cpp:4129-4137): живых токенов он не даёт, это
        // итог уже завершённого запроса, а не текущей генерации
        const cur = n(prom[P_TOK]);
        if (cur < promBase) promSpan = false;          // счётчик откатился (рестарт) — атрибуции нет
        else counter = Math.max(0, cur - promBase);
        if (counter !== null) csrc = "prom";
      }
      // без счётчика скорость не выдумываем: оценка по Δ n_prompt_tokens на живом
      // замере дала бы 0 при 563 сгенерированных токенах (§4.1). Генерация идёт, а
      // счётчика нет — окно уже сброшено выше, человеку говорим прямо.
      // фаза «сервер читает промпт». У форка — её же live.state == "reading". У ванили
      // сравнивать processed надо с размером ПРОМПТА: n_prompt_tokens растёт и от
      // сэмплированных токенов (server-context.cpp:540,700), а processed считает только
      // промпт (:4088-4096), поэтому размер промпта = n_prompt_tokens − n_decoded.
      // Сравнение с самим n_prompt_tokens выдавало бы «читает запрос» на всём декоде.
      const proc = n(slot && slot.n_prompt_tokens_processed);
      const promptBase = prompt === null ? null
        : prompt - (sem && sem.kind === "prompt" ? 0 : Math.max(0, counter || 0));
      const prefill = busy && ((fork !== null && n(fork.reading) === 1) ||
                               (proc !== null && promptBase !== null && proc < promptBase));
      // счётчик токенов ещё не появился, но он появится — это НЕ «счётчика нет вообще»
      const reading = prefill && counter === null;

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
          tokS: lastTokS,                             // наша дельта; среднюю сервера ждём со съёмки ниже
          sec: genAt ? (now - genAt) / 1000 : null,
          at: Math.floor(now / 1000),
        };
        // и своя средняя у форка, и средняя Prometheus появляются только после конца
        // запроса — ждём ту съёмку, что идёт за этим тиком
        if (fork) { forkEnd = true; forkEndSeq = scrapeSeq; }
        if (mode !== "off" && (!props || props.metricsOn !== false))
          { promEnd = true; promEndSeq = promSeq; metricsAt = 0; }
      }

      // ---- §4.3: чем является n_prompt_tokens в этой сборке ----
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
      // средняя Prometheus за запрос — из той же съёмки после конца: при ванильных
      // /slots счётчик был виден и pendingEnd не ставился, а средняя у прежней съёмки
      // про прошлый запрос
      if (promEnd && !busy && promAvg !== null && promSeq !== promEndSeq) {
        if (last) last = { toks: last.toks, tokS: promAvg, sec: endSec, at: last.at };
        promEnd = false;
      }

      // Занятость KV: в ванили n_prompt_tokens УЖЕ включает сэмплированные токены;
      // если поле стоит на месте при растущем счётчике — оно промпт-ориентированное,
      // и тогда плюсует счётчик генерации.
      const used = prompt === null ? null : prompt + (sem && sem.kind === "prompt" ? Math.max(0, counter || 0) : 0);
      // потолок: ванильные поля главнее адаптера — тот только добавляет. Пока /props
      // в этом запуске не ответила (рестарт агента при мёртвом сервере), потолок берём
      // из памяти прошлого съёма, иначе шкала исчезает
      const fromProps = props ? props.ctxMax : (model ? model.ctxMax : null);
      const size = n(slot && slot.n_ctx) ?? fromProps ?? (fork ? fork.ctxMax : null);
      const shownToks = busy ? counter : last ? last.tokS : counter;
      const shownSpeed = busy ? tokS : last ? last.tokS : null;

      // ---- точка кривой: значение ЭТОГО тика, а не последнее измерение ----
      // Ряд идёт тик-в-тик: прелиф, вставший счётчик и простой дают настоящий 0.
      // Прошивка с 2.7.0 (SparkPayload.histN) рисует последние histN точек ряда
      // фиксированным шагом, поэтому ноль — это замер, а не «места нет»; старым
      // прошивкам ряд на первом нуле обрывается, и нулевые точки им режет агент
      // (FirmwareCaps.SparkRealZeros), не плагин. Тиков, когда сервер не ответил,
      // в ряду нет вовсе: ноль там — не замер, а выдумка.
      let point = null;
      if (counter !== null) {
        if (pointBase === null || counter < pointBase) { pointBase = counter; pointAt = now; }
        else {
          const dt = (now - pointAt) / 1000;
          if (dt > 0) { const d = (counter - pointBase) / dt; point = d; }
          pointBase = counter; pointAt = now;
        }
      }
      if (busy) {
        // у форка живую скорость даёт сам сервер — ряд идёт по её же числу, как и карточка
        const ft = csrc === "fork" && fork ? n(fork.tokS) : null;
        if (ft !== null) point = ft;                 // ряд идёт по той же живой скорости, что и карточка
        if (point === null && reading) point = 0;    // промпт читается, токено ещё нет
      } else if (slots !== null || (prom && n(prom[P_BUSY]) !== null) || fork !== null) {
        point = 0;                                   // простой: сгенерировано 0 ток/с
      }
      if (point !== null) point = Math.round(point);
      const shownSec = busy ? (genAt ? (now - genAt) / 1000 : null) : last ? last.sec : null;

      // ---- карточки (§5) ----
      if (point !== null || shownSpeed !== null) {
        // число карточки = точка ряда: прошивка принимает точку spark и как текущее
        // число (src/cards.h: cardHistPush → `spark.cur = point`), поэтому в простое
        // оно 0. Последнее настоящее измерение продолжают держать строка статуса,
        // скорость и ETA карточки генерации и сущность llama.tok_s.
        const v = point !== null ? point : Math.round(shownSpeed);
        ctx.cards.speed.set({ label: "СКОРОСТЬ", number: v, unit: "т/с",
                              windowSec: CURVE_POINTS * intervalSec, state: String(v) }, OPT);
        // Точка — САМО значение, а не высота графика: масштаб кривой прошивка
        // подбирает сама по точкам (renderer_cards/spark.inc); нормировка в 0..255
        // показывала бы на экране высоту — 255 на каждом пике. Точка ряда — байт:
        // скорость выше 255 ток/с в ряд не едет (число карточки, статус и llama.tok_s
        // остаются настоящими), этот тик остаётся без точки.
        if (point !== null && point <= 255) ctx.cards.speed.history(point);
      }

      if (used !== null || size !== null) {
        // карточка показывает заполнение процентом: `number` у gauge на приборе —
        // целое i16, взятое без проверки (src/cards.h, include/card_wire.h:103), а
        // проценты влезают в него при любом потолке. Точные токены остаются в state
        // карточки (у gauge на провод он не едет — card_wire.h:100-107: label, value,
        // unit, bar), в строке статуса и в сущностях llama.context_used / context_size.
        const g = { label: "КОНТЕКСТ" };
        if (used !== null) g.state = String(Math.round(used));
        if (used !== null && size !== null) {
          // потолка нет → процента нет: gauge рисует «—», а не выдуманное число
          g.number = Math.min(100, Math.max(0, Math.round((used * 100) / size)));
          g.unit = "%"; g.min = 0; g.max = 100;
        }
        ctx.cards.context.set(g, OPT);
      }

      if (shownToks !== null) {
        const p = { title: "ГЕНЕРАЦИЯ", titleShort: "ГЕНЕР",
                    state: String(shownToks) };
        if (busy) {
          if (limit !== null) p.pct = Math.round(Math.min(100, (100 * shownToks) / limit));
          else p.indeterminate = true;                     // лимита нет (n_remain = −1) или он не виден вовсе
        } else p.pct = 100;                                 // запрос завершён: полоса полная, даже когда лимита не видели
        if (shownSpeed !== null) p.speed = num(shownSpeed) + " т/с";
        if (busy && limit !== null && shownSpeed !== null && shownSpeed > 0) {
          p.eta = "≈" + Math.max(0, Math.ceil((limit - shownToks) / shownSpeed)) + " с";
        }
        const dur = shownSec !== null ? " · " + num(shownSec, 1) + " с" : "";
        p.foot = [num(shownToks) + " ток" + dur, compact(shownToks) + " ток" + dur,
                  num(shownToks) + " ток", compact(shownToks) + " ток"];
        if (!busy) p.done = true;
        ctx.cards.gen.set(p, OPT);
      }

      const stName = props && props.sleeping ? "ожидает"
        : busy ? (prefill ? "читает запрос" : "генерирует")
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
      if (used !== null && size !== null) bits.push(compact(used) + "/" + compact(size));
      if (shownSpeed !== null) bits.push(Math.round(shownSpeed) + " т/с");
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
