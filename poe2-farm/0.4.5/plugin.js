// «Фарм PoE2» — статистика игровой сессии Path of Exile 2 на панели Usee.
// ТЗ: usee-poe2-farm-tz.md. Срез 1: читаем хвост Client.txt и показываем сессию
// (забеги по картам, смерти, время). Табы и цены — следующий срез; нужные ему
// права (net) объявлены уже сейчас, чтобы установка не менялась.
//
// Правил игры плагин не знает и не нарушает: только читает файл лога (способ,
// разрешённый GGG) и не трогает саму игру.

// ---- разбор Client.txt -------------------------------------------------------

// Строка лога: `2025-12-18 23:10:22 6523218 84b56f99 [INFO Client 23608] текст`.
// GGG меняла разделитель даты (сторонние парсеры ждут слеши) — принимаем оба.
// Неразбираемое время ⇒ строка невидима, а не «сейчас»: обрывок многострочной
// записи не должен создавать событие, которого не было.
function stamp(line) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!m) return null;
  const mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(+m[1], mo - 1, d, h, mi, s).getTime();
}

// Одно событие = одно правило. Неизвестные строки возвращают null: молча не
// понимаем, но и не выдумываем.
//
// Проверялось на реальном Client.txt (375 МБ, сборки 4.4.x…4.5.5, RU-клиент):
//  • «Generating level … area "MapX" with seed N» — внутренний id и зерно карты;
//  • «[SCENE] Set Source [Имя]» — человекочитаемое имя зоны, есть во всех сборках;
//  • «[LOADING SCREEN] (…) Duration = …» — в 4.5.x зона целиком (id, зерно, имя),
//    в 4.4.x только имя: «(Саванна) Duration = 2.4 seconds»;
//  • «Closing game gracefully» — игрок вышел сам: конец игровой сессии.
// Строк «You have entered …» и «has been slain» в PoE2 нет — это маркёры PoE1,
// по ним парсер молчал бы вечно. Гибелей лог не пишет вообще (см. README), так
// что счётчика смертей в плагине нет: вместо него честные время и число карт.
function parseLine(line) {
  const t = stamp(line);
  if (t === null) return null;
  let m = /Generating level (\d+) area "([^"]+)"(?: with seed (\d+))?/.exec(line);
  if (m) return { k: "gen", t, level: +m[1], areaId: m[2], seed: m[3] ? +m[3] : null };
  m = /\[LOADING SCREEN\] \((\S+?) (\d+) - (.*?)\)\s*Duration/.exec(line);
  if (m) return { k: "area", t, areaId: m[1], seed: +m[2], name: okName(m[3]) ? m[3] : "" };
  // В 4.4.x у строки лоадера второй половины нет: «(Саванна) Duration = 2.4 seconds».
  // Id и зерна в ней нет (их даёт «Generating level»), но имя зоны есть — берём его.
  m = /LOADING SCREEN\] \((.*?)\)\s*Duration/.exec(line);
  if (m) return { k: "name", t, name: okName(m[1]) ? m[1] : "" };
  m = /\[SCENE\] Set Source \[([^\]]+)\]/.exec(line);
  if (m) {
    if (m[1] === "(null)" || m[1] === "(unknown)") return null;       // служебная сцена — не зона
    // Имя есть, но нечитаемо (лог приехал не в UTF-8): зону это не отменяет — имя
    // плагин возьмёт из id зоны, а в статусе скажет про кодировку.
    return { k: "name", t, name: okName(m[1]) ? m[1] : "" };
  }
  if (line.indexOf("LOG FILE OPENING") >= 0) return { k: "open", t };
  if (line.indexOf("Closing game gracefully") >= 0) return { k: "quit", t };
  return null;
}

// Логи называют зоны внутренними id («MapColosseum»); человек хочет «Colosseum».
function pretty(areaId) {
  const s = String(areaId).replace(/^Map/, "").replace(/[_-]+/g, " ");
  let out = "";
  for (let i = 0; i < s.length; i++) out += (i === 0 || s[i - 1] === " ") ? s[i].toUpperCase() : s[i];
  return out.trim();
}

// Фарм-забег = карта. Убежище/город — время сессии, но не забега. Неизвестный
// префикс («other») забегом не считаем: лучше не досчитать, чем придумать.
function areaKind(areaId) {
  if (!areaId) return "other";
  if (/^hideout/i.test(areaId)) return "hideout";
  if (/town/i.test(areaId)) return "town";
  if (/^map/i.test(areaId)) return "map";
  return "other";
}

const KIND_LABEL = { map: "карта", hideout: "убежище", town: "город", other: "зона" };

// ---- время ------------------------------------------------------------------

function hms(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  const h = Math.floor(sec / 3600);
  return h > 0 ? h + ":" + p(Math.floor(sec / 60) % 60) + ":" + p(sec % 60) : Math.floor(sec / 60) + ":" + p(sec % 60);
}

function hhmm(ms) { return new Date(ms).toTimeString().slice(0, 5); }

// ---- конфигурация ------------------------------------------------------------

function settings(ctx) {
  const n = function (key, dflt) { const v = Number(ctx.settings.get(key)); return isFinite(v) && v > 0 ? v : dflt; };
  return {
    // 30 минут, а не 15: в реальном логе фарма паузы между строками доходят до
    // 11 минут (тихая карта без CRIT-шума), и сессия рвалась посреди забега.
    // Выход из игры помечает конец сам — пауза остаётся запасой для падения.
    gapMs: n("sessionGapMin", 30) * 60000,
    minMs: n("minRunSec", 60) * 1000,
  };
}

// ---- затраты, чистый доход, санитайзеры --------------------------------------
// Валовый доход есть всегда (лут с вкладок в диванах). Чистый — только если задан
// сетап затрат: планшет амортизируется (цена / число использований на забег,
// счётчик живёт в состоянии), расходники — ручной список «что уходит на забег».
// Модель заимствована у poe2-map-tracker и упрощена под песочницу: прайса лута из
// интернета для PoE2 нет (poe.ninja отдаёт только курсы divine/exalted/chaos,
// индексы предметов 404), поэтому стоимость задаёт человек.

// Эта валюта внутри забега не тратится: её уход из вкладок значит, что в дифф
// попали трейд или крафт, а не фарм.
const NOT_SPENDABLE_IN_MAPS = ["Divine Orb", "Exalted Orb", "Chaos Orb",
                               "Mirror of Kalandra", "Orb of Annulment"];

function settingList(ctx, key) {
  let v = ctx.settings.get(key);
  if (!v) return [];
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { return []; } }
  return Array.isArray(v) ? v : [];
}

function costCfg(ctx) {
  const tablet = Math.max(0, Number(ctx.settings.get("tabletCost")) || 0);
  return {
    tabletCost: tablet,
    tabletUses: tablet > 0 ? Math.max(1, Math.round(num(ctx, "tabletUses", 3))) : 0,
    track: ctx.settings.get("trackTabletUses") !== false,
    items: settingList(ctx, "consumables").map(function (x) {
      return { n: String((x && (x.item || x.name)) || "").trim(), div: Math.max(0, Number(x && x.div) || 0) };
    }).filter(function (x) { return x.n && x.div > 0; }),
    maxDiv: Math.max(1, num(ctx, "maxDivPerRun", 20)),
    auto: ctx.settings.get("autoRules") !== false,
    excluded: settingList(ctx, "excluded")
      .map(function (x) { return String((x && (x.run || x.id)) || "").trim(); })
      .filter(function (s) { return !!s; }),
  };
}

// Стоимость забега. Для открытого забега планшет не тратится — он нужен только
// для предпросмотра.
// Имя расходника человек пишет руками, а уход приходит с сайта: «chaos flask»
// против «Chaos Flask». Сверяем нормализованно, иначе один предмет платится дважды.
function normName(s) { return String(s || "").toLowerCase().replace(/[^a-zа-я0-9]+/g, ""); }

function runCost(cc, S, r, chargeTablet) {
  let cost = 0;
  if (cc.tabletCost > 0 && chargeTablet) cost += cc.tabletCost / Math.max(1, cc.tabletUses);
  const lost = (S && S.runLoss ? S.runLoss[runKey(r)] : null) || {};
  const lostKey = {};
  for (const k in lost) lostKey[normName(k)] = true;
  for (const it of cc.items) {
    if (lostKey[normName(it.n)]) continue;   // вкладка уже показала уход — второй раз не берём
    cost += it.div;
  }
  return cost;
}

// Стоимость списывается один раз при закрытии забега: правка настроек потом не
// должна переписывать историю. Счётчик использований планшета живёт в состоянии
// лога и перевзводится, когда меняется сам сетап (куплен новый планшет).
function chargeRuns(st, cc, S, tradeOn) {
  const key = cc.tabletCost + "|" + cc.tabletUses;
  if (st.tabletKey !== key) { st.tabletKey = key; st.tabletLeft = cc.tabletUses; }
  for (const r of st.runs) {
    if (r.costDiv !== undefined) continue;
    // Пока после конца забега не прошло два ПОЛНЫХ снимка вкладок, стоимость не
    // фиксируем: уход предмета из стеша всегда виден позже, чем кончается забег, и
    // зафиксированная заранее цена потом сложится с этим уходом (переплата). До
    // фиксирования карточка считает предпросмотр по текущим настройкам.
    // Без учётной половины вкладок доказательства нет вовсе — списываем сразу.
    const end = r.endTs !== undefined ? r.endTs : (r.startTs || 0) + (r.segMs || 0);
    if (tradeOn && (end <= 0 || !S || S.baseline || (S.prevFullTs || 0) < end)) continue;
    const can = cc.tabletCost > 0 && (!cc.track || st.tabletLeft > 0);
    if (can && cc.track) st.tabletLeft--;
    r.costDiv = Math.round(runCost(cc, S, r, can) * 100) / 100;
  }
}

// Порог выброса — абсолютный: max(median + 3·MAD, maxDivPerRun). При медиане 0
// (большинство забегов без лута) «k от медианы» дало бы ноль и флаг вешался бы на
// любой удачный дроп.
function outlierThreshold(vals, floor) {
  if (!vals.length) return floor;
  const s = vals.slice().sort(function (a, b) { return a - b; });
  const med = s[Math.floor(s.length / 2)];
  const dev = s.map(function (v) { return Math.abs(v - med); }).sort(function (a, b) { return a - b; });
  return Math.max(floor, med + 3 * dev[Math.floor(dev.length / 2)]);
}

// Средние считаются по нетто. Подозрительные забеги при autoRules выпадуют из
// средних, при выключенных — только помечаются; ручное исключение работает всегда.
function money(st, S, cc, k) {
  const g0 = (S && S.runDiv) || {}, sus0 = (S && S.susp) || {};
  const vals = k.runs.map(function (r) { return (g0[runKey(r)] || 0) - (r.costDiv || 0); });
  const thr = outlierThreshold(vals, cc.maxDiv);
  let gross = 0, cost = 0, net = 0, counted = 0, sus = 0;
  for (let i = 0; i < k.runs.length; i++) {
    const r = k.runs[i], key = runKey(r), g = g0[key] || 0;
    const rc = r.costDiv !== undefined ? r.costDiv : runCost(cc, S, r, false);
    gross += g; cost += rc;
    if (cc.excluded.indexOf(key) >= 0) continue;
    if (sus0[key] || vals[i] > thr) { sus++; if (cc.auto) continue; }
    net += g - rc; counted++;
  }
  return { gross: gross, cost: cost, net: net, counted: counted, sus: sus, thr: thr };
}

// Пометки подозрительного «выброса» пишет трейд-опрос (он владелец ключа «stash»),
// чтобы форма настроек могла показать список даже после закрытия сессии.
// Набор забегов и порог — те же, что видит money(): иначе карточка вешает ⚠ по
// одному набору забегов, а средний доход считает по другому.
function markSuspects(st, S, cc, k) {
  const rs = k.runs;
  const vals = rs.map(function (r) { return ((S.runDiv || {})[runKey(r)] || 0) - (r.costDiv || 0); });
  const thr = outlierThreshold(vals, cc.maxDiv);
  S.thr = Math.round(thr * 100) / 100;
  for (let i = 0; i < rs.length; i++) {
    if (vals[i] <= thr) continue;
    const key = runKey(rs[i]);
    if (!S.susp[key]) S.susp[key] = "выигрыш " + fmtDiv(vals[i]) + " div выше порога " + fmtDiv(thr);
  }
}

// ---- доступ к логу -----------------------------------------------------------

// Хвост читаем объявленным в манифесте скелетом (PowerShell Get-Content -Tail):
// весь Client.txt в песочницу не тянем (лимит exec — 256 КБ вывода, файл — десятки
// мегабайт); размер хвоста задаёт манифест, а не параметр из JS.
// Имя файла — из настройки; папка в argv не попадает (рабочий каталог команды —
// значение настройки logDir), поэтому путь с пробелами вроде «Program Files (x86)»
// не ломает разбор командной строки PowerShell.
function logFile(ctx) {
  const f = String(ctx.settings.get("logFile") || "Client.txt").trim();
  return /^[A-Za-z0-9 ._-]+$/.test(f) ? f : null;
}

// Хвост меряют в байтах, а не в строках. Вывод команды ограничен 256 КБ, и «-Tail
// 4000» на реальном логу (173 байта/строка) даёт 450 КБ: команда не завершается
// вовсе, хост снимает её по таймауту, и плагин навсегда залипает в «лога нет».
// Сколько строк влезет — считаем по средней длине строки, измеренной на прошлом
// хвосте; если вывод всё же обрезан, оценка уточняется вниз.
const EXEC_BUDGET = 180000;            // байт вывода: до потолка хоста остаётся запас
const BIG_MIN = 200, BIG_MAX = 1200;   // границы числа строк большого хвоста

async function readTail(ctx, big, st) {
  const file = logFile(ctx);
  if (!file) return { err: "имя файла лога неподходящее (буквы, цифры, точка, пробел, дефис)", short: "имя файла" };
  const lines = big ? Math.max(BIG_MIN, Math.min(BIG_MAX,
                    Math.floor(EXEC_BUDGET / (st.avgLine > 0 ? st.avgLine : 200)))) : 0;
  let r;
  try {
    r = big ? await ctx.exec.run("tailBig", { file: file, lines: String(lines) })
            : await ctx.exec.run("tail", { file: file });
  }
  catch (e) {
    const why = typeof e === "string" ? e : (e && e.message) || "?";
    return { err: "команда лога отклонена хостом: " + why,
             short: why.indexOf("папка") >= 0 ? "папки нет" : "команда отклонена" };
  }
  if (r.truncated) {                   // вывод обрезан: строк было слишком много.
    // Раз вывод не влез, средняя длина строки заведомо больше 256 КБ / lines —
    // берём её с запасом, иначе следующая попытка была бы ровно такой же.
    st.avgLine = Math.ceil(262144 / Math.max(1, lines) * 1.2);
    return { err: "хвост не влез в вывод (" + lines + " строк): в следующий раз возьмём меньше",
             short: "хвост не влез" };
  }
  if (r.code !== 0) {
    // Код плюс первая строка ответа команды: «файл открыт игрой», «нет доступа» и
    // «нет такого файла» различаются именно здесь, а не по общей фразе «лога нет».
    const why = String(r.stderr || "").split("\n")[0].trim().slice(0, 140);
    return { err: "лог не читается (код " + r.code + ")" + (why ? ": " + why : ""), short: "код " + r.code };
  }
  const out = String(r.stdout || "");
  if (!out.trim()) return { err: "лог пуст", short: "лог пуст" };
  const res = { lines: out.split(/\r?\n/), bytes: out.length,
                mangled: out.indexOf("\uFFFD") >= 0 };
  st.avgLine = Math.max(40, Math.round(res.bytes / Math.max(1, res.lines.length)));
  return res;
}

// ---- машина состояний «сессия / забег» ---------------------------------------

const RUNS_CAP = 50;      // записей забегов в памяти и в storage
const SEEN_CAP = 4000;    // страховка; по-настоящему отпечатки чистятся по времени хвоста

function blank() {
  return { lastTs: 0, maxTs: 0, session: null, finished: null, run: null, runs: [], seen: [],
           avgLine: 0,
           pending: null, zone: null, escalate: false, gapSec: 0, lineTs: 0, curArea: "",
           tabletKey: "", tabletLeft: 0 };
}

function loadState(ctx) {
  const raw = ctx.storage.get("state");
  if (!raw || typeof raw !== "object") return blank();
  const st = blank();
  for (const k in st) if (raw[k] !== undefined) st[k] = raw[k];
  return st;
}

// Отпечаток события: та же строка, попавшая в хвост дважды (хвост перекрывается
// при каждом опросе), обрабатывается один раз.
function fingerprint(ev) {
  if (ev.k === "gen") return "g" + ev.t + "@" + ev.areaId + "/" + (ev.seed || "");
  if (ev.k === "area") return "a" + ev.t + "@" + ev.areaId + "/" + ev.seed;
  if (ev.k === "name") return "n" + ev.t + "@" + ev.name;
  if (ev.k === "quit") return "q" + ev.t;
  return "o" + ev.t;
}

// Отпечаток начинается с буквы типа и метки времени события.
function seenTs(fp) { const m = /^[a-z](\d+)/.exec(fp); return m ? +m[1] : 0; }

function closeRun(st, at) {
  if (!st.run) return;
  st.run.segMs += Math.max(0, at - st.run.segStart);
  st.run.endTs = at;
  st.runs.push(st.run);
  if (st.runs.length > RUNS_CAP) st.runs.splice(0, st.runs.length - RUNS_CAP);
  st.run = null;
}

function closeSession(st, at, notes) {
  closeRun(st, at);
  // Итоги окончившейся сессии остаются на карточках, пока не начнётся новая:
  // «карт 0» после пауды читалось бы как «фарм был нулевой».
  if (st.session) {
    st.finished = { start: st.session.start, end: at };
    if (notes) notes.sessionClosed = true;
  }
  st.session = null;
}

// Возврат в ту же карту (тот же areaId+seed) внутри сессии — продолжение того же
// забега, а не новый забег: запись возвращается из истории в текущую.
function reopenRun(st, areaId, seed) {
  const sess = st.session ? st.session.start : 0;
  for (let i = st.runs.length - 1; i >= 0; i--) {
    const r = st.runs[i];
    if (r.sess === sess && r.areaId === areaId && r.seed === seed) {
      st.runs.splice(i, 1);
      st.run = r;
      return true;
    }
  }
  return false;
}

function applyEvent(st, ev, notes) {
  // Время в логе раньше уже обработанного ⇒ лог пересняли (перезапуск игры, откат
  // часов). Сессия рвётся: иначе длительности становятся отрицательными.
  if (st.lastTs && ev.t < st.lastTs) {
    closeSession(st, st.lastTs, notes);
    st.lastTs = ev.t;
    st.maxTs = Math.min(st.maxTs, ev.t);      // «сейчас» тоже переезжает в новую метку
    notes.rollback = true;
  }
  // Паузу ищет feed по строкам лога: события в карте редки, а лог идёт всё время,
  // поэтому «долго не было событий» — не признак конца сессии.
  if (!st.session) st.session = { start: ev.t, sessStart: ev.t };
  st.lastTs = Math.max(st.lastTs, ev.t);

  if (ev.k === "open") return;                       // новый файл лога: смену сессии не означает
  // Игрок вышел сам — это явный конец сессии, паузы ждать не нужно.
  if (ev.k === "quit") { closeSession(st, ev.t, notes); st.curArea = ""; return; }
  if (ev.k === "gen") { st.pending = { areaId: ev.areaId, seed: ev.seed }; return; }

  // LOADING SCREEN называет зону сама (id + зерно + имя).
  if (ev.k === "area") { st.pending = null; enterZone(st, ev.areaId, ev.seed, ev.name, ev.t); return; }

  // SCENE даёт только имя: привязываем его к последней генерации. Имя берётся
  // первое после генерации — сцены интерфейса («Атлас») уже игнорируются.
  if (ev.k === "name") {
    if (st.pending) {
      const area = st.pending; st.pending = null;
      enterZone(st, area.areaId, area.seed, ev.name, ev.t);
    } else if (st.run && !st.run.name) {
      st.run.name = ev.name;
      if (st.zone && !st.zone.named) { st.zone.name = ev.name; st.zone.named = true; }
    }
    return;
  }
}

// Вход в зону: граница забега. Одна и та же зона часто описана двумя строками
// (SCENE, потом LOADING SCREEN), поэтому повтор входа в ту же зону (тот же id и
// зерно) не открывает новый сегмент, а только уточняет имя.
// Имя зоны обязано быть читаемым: `(null)`, `(unknown)` и символы замены U+FFFD
// (так хост разбирает байты не-UTF-8) на панель не несут — шрифт рисует квадраты,
// а в превью агента от них вообще ничего не остаётся.
function okName(s) {
  return !!s && s !== "(null)" && s !== "(unknown)" && s.indexOf("\uFFFD") < 0;
}

// Имена, которые пришли битыми в прошлых опросах (лог не в UTF-8), живут в памяти
// плагина и после починки кодировки: панель продолжала бы рисовать квадраты, пока
// игрок не сменит зону. Чистим их при загрузке состояния.
function scrubNames(st) {
  const fix = function (o, areaId) {
    if (o && !okName(o.name)) { o.name = pretty(areaId || ""); o.named = false; }
  };
  fix(st.zone, st.curArea ? String(st.curArea).split("/")[0] : "");
  for (const r of st.runs || []) fix(r, r.areaId);
  if (st.run) fix(st.run, st.run.areaId);
}

function enterZone(st, areaId, seed, name, at) {
  const id = (areaId || "?") + "/" + (seed || "");
  if (st.curArea === id) {
    if (st.run && !st.run.name && name) { st.run.name = name; if (st.zone) st.zone.name = name; }
    return;
  }
  st.curArea = id;
  const kind = areaKind(areaId);
  st.zone = { name: name || pretty(areaId), kind: kind, at: at, named: !!name };
  if (kind !== "map") { closeRun(st, at); return; }    // убежище, город, неизвестная зона
  if (!st.run && reopenRun(st, areaId, seed)) { st.run.segStart = at; return; }
  closeRun(st, at);
  st.run = { areaId: areaId, seed: seed, name: name || pretty(areaId), kind: kind,
             segMs: 0, segStart: at, startTs: at, sess: st.session ? st.session.start : 0 };
}

// Кормим состоянием строки хвоста; отпечатки не дают перекрывающемуся хвосту
// удвоить события.
// silenceOk=false в первом же размеченном строке: если хвост не покрыл лог
// (missed), дыра в нём — наша вина, а не молчание игрока.
function feed(st, lines, c, notes, silenceOk) {
  // Отпечатки нужны ровно на перекрытие с прошлым хвостом: лог дописывается в конец,
  // и событие раньше первой строки этого хвоста встретиться больше не может. Значит
  // всё, что старше хвоста, выбрасываем, а кап по количеству остаётся страховкой от
  // безумного лога (400 при 4000 строк большого хвоста означали бы повторный счёт
  // части событий: в реальном логе событий больше 800 на 4000 строк).
  let firstTs = 0;
  for (const line of lines) { const x = stamp(line); if (x !== null) { firstTs = x; break; } }
  if (firstTs) {
    let cut = 0;
    while (cut < st.seen.length && seenTs(st.seen[cut]) < firstTs) cut++;
    if (cut) st.seen.splice(0, cut);
  }
  for (const line of lines) {
    const t = stamp(line);
    if (t === null) continue;
    if (t > st.maxTs) st.maxTs = t;
    // Сам лог молчал дольше sessionGapMin ⇒ игрок ушёл/игра закрылась: сессия
    // окончена. Дыр между СОБЫТИЯМИ не смотрим — карта живёт минутами без строк.
    if (silenceOk !== false && c.gapMs && st.lineTs && t - st.lineTs > c.gapMs && t > st.lineTs) {
      if (st.session) closeSession(st, st.lineTs, notes);
      notes.silence = true;
    }
    silenceOk = true;
    if (t > st.lineTs) st.lineTs = t;
    const ev = parseLine(line);
    if (!ev) continue;
    const fp = fingerprint(ev);
    if (st.seen.indexOf(fp) >= 0) continue;
    st.seen.push(fp);
    if (st.seen.length > SEEN_CAP) st.seen.splice(0, st.seen.length - SEEN_CAP);
    applyEvent(st, ev, notes);
  }
}

function counts(st, c) {
  // Считаем текущую сессию, а после её окончания — последнюю закончившуюся.
  const sess = st.session ? st.session.start : (st.finished ? st.finished.start : 0);
  const now = st.session ? Math.max(st.lastTs, st.maxTs) : (st.finished ? st.finished.end : 0);
  const openMs = st.run ? st.run.segMs + Math.max(0, now - st.run.segStart) : 0;
  const runs = st.runs.filter(function (r) { return r.segMs >= c.minMs && r.sess === sess; });
  if (st.run && openMs >= c.minMs) runs.push(Object.assign({}, st.run, { segMs: openMs }));
  let mapMs = 0;
  for (const r of runs) mapMs += r.segMs;
  return { runs: runs, mapMs: mapMs, openMs: openMs,
           wallMs: st.session ? Math.max(0, now - st.session.start)
                              : (st.finished ? Math.max(0, st.finished.end - st.finished.start) : 0) };
}

// ---- trade2: лут по публичным вкладкам -------------------------------------

// Публичный поиск trade2 — без входа в аккаунт и без POESESSID. Вкладка делается
// публичной правым кликом в игре, а её цена задаётся именем «~price <N> divine
// Метка», поэтому число N работает селектором вкладки: по нему и разбираем вкладки
// по разным запросам (проверено на живом аккаунте: 990 Currency, 991 Expedition …).
//
// Считаем позиции по их id. Id позиции меняется при перелицовке стека, но вместе с
// ним из поиска пропадает и старый id: находка и уход находятся парами, двойного счёта
// нет (проверено на живом аккаунте: перелицовка стека 16 div — старый id исчез, новый
// появился, сумма не изменилась). Дата индексации — момент последней перелицовки, а не
// момент, когда предмет упал в стеш; находкой считается только то, чего не было на
// прошлом ПОЛНОМ снимке.
//
// Замеры с этого же IP (см. usee-poe2-farm-plan-2-trade.md §0): пагинации у поиска
// нет (offset/page/view ничего не сдвигают), ответ отдаёт ≤100 id; лимит поиска
// 5/10с, 15/мин, 30/5мин, 600/6ч; превышение — 429 с Retry-After: 60.
const TR = "https://www.pathofexile.com/api/trade2";
const UA = "UseePanel (personal farm stats: Client.txt + public trade search)";
const SEARCH_RULES = "5:10:60,15:60:300,30:300:1800,600:21600:3600";
const FETCH_RULES = "12:4:10,16:12:300,50:300:1800,1000:21600:1800";
// Кэш позиций обязан влезть в хранилище плагина (256 КБ на плагин). Замерено на
// живом аккаунте: позиция с именем ~172 Б в кэше + ~70 Б в снимке, без имени
// ~40 Б + ~70 Б. Когда начинается теснота, старые не-divine позиции забывают
// имя/вкладку/класс, но оставляют стек, время индексации и полосу цены.
const STASH_BUDGET = 180000;        // символов JSON: с запасом до потолка хоста
const DEFLATE_BYTES = 130;          // сколько экономит одна позабытая позиция
// Сколько id в раньше пустой полосе цены означает «вкладка появилась», а не «пришёл лут».
const NEW_TAB_MIN = 3;
const MAX_FETCH_PER_SWEEP = 100;    // пачек по 10 id за свип: аккаунт на 400+ позиций обязан влезать целиком
const MAX_WAIT_MS = 45000;          // дольше не ждём: честнее оборвать свип, чем молчать вечность
const ATTR_TOL_MS = 120000;         // лаг индексации: находку относим к забегу с запасом
// Чем сейчас болен источник лога (пусто — читается). Статус плагина один, а опросов
// два: без этого флага добрый текст опроса вкладок перетирает сообщение «лога нет»,
// и на живом агенте карточка болела молча.
let logBad = "";
function statusWith(extra) { return [logBad, extra].filter(function (x) { return !!x; }).join(" · "); }

const DIVINE = "Divine Orb";
const FRESH_IDS = 10;               // сколько самых свежих позиций обновляем каждый цикл

function num(ctx, key, dflt) { const v = Number(ctx.settings.get(key)); return isFinite(v) && v > 0 ? v : dflt; }

function tradeCfg(ctx) {
  const acc = String(ctx.settings.get("tradeAccount") || "").trim();
  const from = Math.round(num(ctx, "tabPriceFrom", 990));
  return {
    // без аккаунта или с выключенным учётом запросов нет вовсе
    on: ctx.settings.get("stashOn") !== false && /^\S+#\d{4}$/.test(acc),
    account: acc,
    league: String(ctx.settings.get("league") || "").trim(),
    from: from,
    to: Math.max(from, Math.round(num(ctx, "tabPriceTo", 999))),
    fullMs: num(ctx, "fullSweepMin", 15) * 60000,
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Циклы и await. Возобновление async-функции после await внутри `for (let i = …; …;
// i++)` роняет песочницу хоста (Jint 4.12: InvalidCastException при разборе
// идентификатора), если витков больше одного. Здесь такие циклы — на while/for-of.

// Лимитер повторяет счёт самого сайта: правила «max:period:penalty», состояние
// «hits:period:restricted», периоды в секундах. Состояние читаем с любого ответа: в
// нём учтены запросы других инструментов с того же IP, поэтому считать только свои —
// значит получать 429 на чужой скорости.
function rulesOf(text, dflt) {
  const out = [];
  for (const part of String(text || dflt).split(",")) {
    const a = part.split(":").map(Number);
    if (a.length >= 2 && a.every(isFinite)) out.push({ max: a[0], period: a[1] * 1000, penalty: a[2] || 0 });
  }
  return out.length ? out : rulesOf(dflt, "");
}

function bucket(raw, dflt) {
  const b = raw && typeof raw === "object" ? raw : {};
  b.hits = Array.isArray(b.hits) ? b.hits : [];
  b.fgn = Array.isArray(b.fgn) ? b.fgn : [];        // показание сайта по каждому окну: { n, at }
  b.blockedUntil = b.blockedUntil || 0;
  b.rulesTxt = b.rulesTxt || dflt;
  b.rules = rulesOf(b.rulesTxt, dflt);
  return b;
}

// Ждать ли и сколько. Свои запросы известны точно — их моменты в b.hits. Чужие
// (другой инструмент с того же IP) известны только числом в окне и только на момент
// ответа сайта, поэтому они живут отдельным показанием на окно и считаются
// освобождающимися с той скоростью, которую окно разрешает (period / max).
// Ставить чужие попадания в «сейчас» нельзя: окно выглядит заполненным только что,
// ожидание вырастает до всего периода, а попадания одного окна просачиваются в
// оценку другого — на живых правилах это пять минут простоя вместо работы.
function waitMs(b, now) {
  let wait = Math.max(0, b.blockedUntil - now);
  for (let i = 0; i < b.rules.length; i++) {
    const r = b.rules[i];
    const own = b.hits.filter(function (h) { return h > now - r.period; })
                      .sort(function (x, y) { return x - y; });
    const f = b.fgn[i];
    const foreign = f && f.n > 0 ? Math.max(0, f.n - (now - f.at) * f.n / r.period) : 0;
    const allowed = Math.max(1, r.max - 1);          // один запрос всегда держим в запасе
    const used = own.length + Math.ceil(foreign);
    if (used < allowed) continue;
    let w = 0;
    // свои окна освобождаются по известным моментам — это точный расчёт
    if (own.length >= allowed) w = own[own.length - allowed] + r.period - now + 50;
    // чужие — только по расписанию самого окна
    if (foreign > 0) w = Math.max(w, (used - allowed + 1) * r.period / r.max + 50);
    wait = Math.max(wait, w);
  }
  return wait;
}

function noteHit(b, now) {
  b.hits.push(now);
  let longest = 0;
  for (const r of b.rules) longest = Math.max(longest, r.period);
  b.hits = b.hits.filter(function (h) { return h > now - longest; });
  if (b.hits.length > 800) b.hits = b.hits.slice(-800);
}

function watchHeaders(b, res, now) {
  const r = res.header("x-rate-limit-ip");
  if (r && r !== b.rulesTxt) { b.rulesTxt = r; b.rules = rulesOf(r, b.rulesTxt); }
  const s = res.header("x-rate-limit-ip-state");
  if (s) String(s).split(",").forEach(function (part, i) {
    const a = part.split(":").map(Number);
    if (!isFinite(a[0]) || !isFinite(a[1])) return;
    if (isFinite(a[2]) && a[2] > 0) b.blockedUntil = Math.max(b.blockedUntil, now + a[2] * 1000);
    const rule = b.rules[i];
    if (!rule) return;
    const local = b.hits.filter(function (h) { return h > now - rule.period; }).length;
    // показание сайта относится к этому окну и к моменту ответа, а не к «сейчас»:
    // хранится отдельно, чтобы не отравлять другие окна
    b.fgn[i] = { n: Math.max(0, a[0] - local), at: now };
  });
  const ra = res.header("retry-after");
  if (ra) { const n = Number(ra); if (isFinite(n) && n > 0) b.blockedUntil = Math.max(b.blockedUntil, now + n * 1000); }
}

// null ⇒ запрос не состоялся: заметка в notes уже есть, а свип решит сам, продолжать
// или остановиться. Ждём недолго: если бюджет просит паузу больше MAX_WAIT_MS, свип
// честно обрывается — опрос лога не должен стоять из-за сети.
async function tradeReq(ctx, b, url, body, notes) {
  let guard = 0;
  while (guard++ < 2) {
    const w = waitMs(b, Date.now());
    if (w === 0) break;
    if (w > MAX_WAIT_MS) { notes.wait = Math.max(notes.wait || 0, w); return null; }
    await sleep(w);
  }
  let r;
  try {
    // User-Agent обязателен: явный пустой UA GGG режет 403 (проверено: без UA —
    // «Forbidden», с любым осмысленным — 200). .NET по умолчанию UA не шлёт вообще,
    // так что без этой строки торговый слой был бы слепой. Мы не прикидываемся
    // браузером: имя говорит, кто стучится и зачем.
    const head = { "user-agent": UA };
    if (body) head["Content-Type"] = "application/json";
    r = await ctx.net.fetch(url, body
      ? { method: "POST", headers: head, body: body }
      : { headers: head });
  } catch (e) {
    notes.err = "trade2: " + (typeof e === "string" ? e : (e && e.message) || "нет связи");
    return null;
  }
  const now = Date.now();
  watchHeaders(b, r, now);
  noteHit(b, now);
  if (r.status === 429) { notes.err = "trade2 ограничил частоту"; return null; }
  if (!r.ok) { notes.err = "trade2 ответил " + r.status; return null; }
  try { return r.json(); } catch (e) { notes.err = "trade2 ответил не JSON"; return null; }
}

function searchBody(acc, min, max, byFresh) {
  return JSON.stringify({
    query: { status: { option: "any" },
             filters: { trade_filters: { filters: { account: { input: acc },
                                                    price: { option: "divine", min: min, max: max } } } } },
    sort: byFresh ? { indexed: "desc" } : { price: "asc" },
  });
}

// Лига — с самого сайта (настройка пустая = авто): первая poe2-лига без HC и «Standard».
async function leagueOf(ctx, S, t, notes) {
  if (t.league) return t.league;
  if (S.league && Date.now() - S.leagueTs < 86400000) return S.league;
  const j = await tradeReq(ctx, S.lim.search, TR + "/data/leagues", null, notes);
  if (j && Array.isArray(j.result)) {
    for (const e of j.result) {
      if (e.realm && e.realm !== "poe2") continue;
      if (/^(HC |Ruthless)/.test(e.id) || /^(Standard|Hardcore)$/.test(e.id)) continue;
      S.league = e.id;
      break;
    }
    S.leagueTs = Date.now();
  }
  return S.league || "";
}

// Позиция стеша в кэше: id → {n: имя, s: stackSize, f: frameTypeId, i: индексация(ms),
// t: имя вкладки, p: цена вкладки}. Без i — детали ещё не получены, в агрегатах
// такая позиция не участвует (иначе «ждущая» позиция посчиталась бы одним предметом).
function mergeListings(S, doc) {
  const rows = doc && Array.isArray(doc.result) ? doc.result : [];
  for (const it of rows) {
    if (!it || !it.id) continue;
    const l = it.listing || {}, item = it.item || {}, stash = l.stash || {}, price = l.price || {};
    const e = S.ids[it.id] || (S.ids[it.id] = {});
    e.n = item.typeLine || item.baseType || item.name || "?";
    e.s = item.stackSize || 1;
    e.f = item.frameTypeId || "";
    e.i = Date.parse(l.indexed || "") || 0;
    if (stash.name) e.t = stash.name;
    if (price.amount) e.p = price.amount;
  }
  return rows.length;
}

// --- снимок стеша: {id: сколько предмета лежит на позиции} ---------------------
// Дифф по id позиции, а не по «вкладка|предмет»: id и так лежит в кэше, а сравнение
// по нему даёт и точное время находки (дата индексации именно этой позиции), и
// различие «пришёл новый стек» / «вырос существующий».
// Лаг индексации: сайт индексирует вкладки не мгновенно. Пока лаг большой, цифры на
// карточке «вчерашние» — карточка обязана это говорить, а не показывать их молча.
// Первая «не влезшая» вкладка (её слотов больше, чем отдаёт один ответ поиска).
function bigFirst(S) {
  const k = Object.keys((S && S.big) || {});
  return k.length ? S.big[k[0]] : null;
}

function lagMinutes(S) {
  let newest = 0;
  for (const id in S.ids) if (S.ids[id].i > newest) newest = S.ids[id].i;
  if (!newest) return 0;
  return Math.max(0, Math.round((Date.now() - newest) / 60000));
}

// Память плагина — 256 КБ на плагин, и кэш позиций упирается именно в них, а не в
// счётчик записей. Когда места не хватает, из старых не-divine позиций выбрасываются
// имя, вкладка и класс: стек, время индексации и полоса цены остаются, поэтому
// находка и уход не теряются и не придумываются, а div считается точно — имя
// listing'а не меняется, и не-divine предмет деньгами не становится. Теряется
// только подпись в тосте и ключ защиты от задвоенного расхода.
// Прежний «кэш переполнен → строим базу заново» стоил дороже: он сжигал накопленный
// дифф, а лут, пришедший за время пересборки, молча пропадал.
function deflating(S) {
  let size = JSON.stringify(S).length;
  const victims = [];
  for (const id in S.ids) { const e = S.ids[id]; if (e.n && e.n !== DIVINE) victims.push(id); }
  victims.sort(function (x, y) {
    return (S.ids[x].a || 0) - (S.ids[y].a || 0) || (S.ids[x].i || 0) - (S.ids[y].i || 0);
  });
  let dropped = 0, i = 0;
  while (i < victims.length && size > STASH_BUDGET) {
    const e = S.ids[victims[i]];
    size -= DEFLATE_BYTES;
    delete e.n; delete e.t; delete e.f;
    dropped++; i++;
  }
  let nameless = 0;
  for (const id in S.ids) if (!S.ids[id].n) nameless++;
  S.nameless = nameless;
  return dropped;
}

function counted(S, mark) {
  const m = {};
  for (const id in S.ids) {
    const e = S.ids[id];
    if (!e.i) continue;
    if (e.b) {
      // Позицию невлезшей вкладки перечислить нельзя, значит про неё не известно
      // НИЧЕГО: ни находки, ни ухода. Замораживаем последнее виденное значение —
      // иначе вкладка, переполнившаяся между снимками, рисуется как «−N div».
      const was = S.snap && S.snap[id];
      if (was !== undefined) m[id] = was;
      continue;
    }
    // Полный снимок считает только то, что нашёл этот свип: не найденное и есть уход
    // позиции. Частичный цикл (одна тройка свежих) об отсутствии ничего не знает.
    if (mark !== null && mark !== undefined && e.a !== mark) continue;
    m[id] = e.s || 1;
  }
  return m;
}

function commitSnapshot(S, notes, mark) {
  if (notes.err || notes.capped || notes.partial) return false;
  const next = counted(S, mark === undefined ? null : mark), before = S.snap || {};
  // Полоса цены — это и есть вкладка. Если полоса была пустая, а в ней сразу
  // появилась охапка id, значит таб только что сделали публичным (или переименовали):
  // это не находка фарма, а новый источник. Такие позиции из счёта выпадают,
  // человек получает тост.
  const wasBand = {}, nowBand = {};
  for (const id in before) { const p = (S.ids[id] || {}).p; if (p) wasBand[p] = (wasBand[p] || 0) + 1; }
  for (const id in next) { const p = (S.ids[id] || {}).p; if (p) nowBand[p] = (nowBand[p] || 0) + 1; }
  const fresh = function (id) {
    const p = (S.ids[id] || {}).p;
    return !!p && !wasBand[p] && (nowBand[p] || 0) >= NEW_TAB_MIN;
  };
  for (const id in next) {
    const a = next[id], b = before[id], e = S.ids[id];
    if (b === undefined) {
      if (S.baseline) continue;                          // база: это ещё не находка
      notes.gains.push({ item: e.n || "?", tab: e.t || "?", f: e.f || "", n: a, pos: 1, t: e.i, nt: fresh(id) });
      continue;
    }
    if (a === b) continue;
    if (a > b) notes.gains.push({ item: e.n || "?", tab: e.t || "?", f: e.f || "", n: a - b, pos: 0, t: e.i, nt: fresh(id) });
    else notes.losses.push({ item: e.n || "?", tab: e.t || "?", f: e.f || "", n: a - b, pos: 0, t: e.i, seen: e.i });
  }
  // Позиция пропала из выдачи = предмет ушёл из вкладки (продан, съеден, выброшен).
  // Это расход, а не «минус доход». Имена берём из кэша: чистка идёт после диффа.
  for (const id in before) {
    if (next[id] === undefined) {
      const e = S.ids[id] || {};
      notes.losses.push({ item: e.n || "?", tab: e.t || "?", f: e.f || "",
                          n: -(before[id] || 0), pos: -1, t: S.sweepTs, seen: e.i });
    }
  }
  S.snap = next;
  return true;
}

// Один цикл учёта. Дешёвая часть — всегда: один поиск-триггер + десятка самых свежих
// позиций. Полный снимок вкладок — по первому запуску, по триггеру или по времени.
async function sweepStash(ctx, S, t, notes) {
  // t — настройки учёта вкладок (tradeCfg), а не настроек лога: перепутать их значит
  // потерять и лигу, и диапазон цен вкладок.
  const lg = await leagueOf(ctx, S, t, notes);
  if (!lg) { if (!notes.err) notes.err = "лига не определена"; return; }
  const searchUrl = TR + "/search/poe2/" + encodeURIComponent(lg);

  // 1. триггер: число позиций и самая свежепроиндексированная позиция аккаунта.
  // Пока база не снята, триггер не нужен: полный снимок и так перечисляет все
  // вкладки, а каждый лишний поиск во время постройки отнимает бюджет у постройки.
  let probe = null, top = null;
  if (S.snap)
  {
    probe = await tradeReq(ctx, S.lim.search, searchUrl, searchBody(t.account, t.from, t.to, true), notes);
    if (!probe) return;
    top = (probe.result || [])[0] || null;
  }
  let full = !S.snap;
  // «свежая десятка» сравнивается только если она была: после свипа без триггера
  // probeId пустой, и первый же триггер иначе выглядел бы изменением — лишний полный
  // снимок на пустом месте
  if (probe && (probe.total !== S.total || (S.probeId && top !== S.probeId) || Date.now() - S.fullTs > t.fullMs)) full = true;
  if (probe) { S.total = probe.total; S.probeId = top; }

  // 2. свежие позиции: их stackSize обязан быть актуальным — божественные приходят
  //    на уже существующую позицию, и без свежего стека доход не увидеть
  if (top) {
    const fresh = (probe.result || []).slice(0, FRESH_IDS);
    const d = await tradeReq(ctx, S.lim.fetch,
      TR + "/fetch/" + fresh.join(",") + "?query=" + encodeURIComponent(probe.id), null, notes);
    if (d) mergeListings(S, d);
  }
  S.lagMin = lagMinutes(S);
  if (!full) {
    // Пока база не снята, частичный цикл писать снимок не должен: позиция, увиденная
    // впервые через десятку свежих, иначе «сгорит» и никогда не станет находкой.
    if (!S.baseline) commitSnapshot(S, notes, null);
    return;
  }

  // 3. полный снимок: по одному поиску на каждое число цены
  const byPrice = {}, prices = [];
  // Полный снимок: по одному поиску на цену вкладки. Если лимитер оборвал свип,
  // следующий цикл продолжает с той же вкладки (S.tabCursor), а не начинает сначала:
  // на живых правилах «5 запросов / 10 секунд» девять вкладок — это больше минуты,
  // и начинать каждый раз с нуля значит не закончить никогда.
  if (S.tabCursor < t.from || S.tabCursor > t.to || S.sweepFrom !== t.from || S.sweepTo !== t.to) {
    S.tabCursor = t.from; S.sweepId = (S.sweepId || 0) + 1;
    S.sweepFrom = t.from; S.sweepTo = t.to;
  }
  let p = S.tabCursor;
  let seenTotal = 0;
  // Какие цены не влезают в один ответ, копим на весь свип: после обрыва на лимитере
  // следующий заход перечисляет только оставшиеся вкладки, и карта «невлезших» обязана
  // пережить перерыв, иначе позиции такой вкладки посчитаются наполовину.
  if (!S.bigScan || S.bigScan.s !== S.sweepId) S.bigScan = { s: S.sweepId, p: {} };
  const big = S.bigScan.p;
  while (p <= t.to) {
    const s = await tradeReq(ctx, S.lim.search, searchUrl, searchBody(t.account, p, p, false), notes);
    if (!s) { notes.partial = true; break; }             // S.tabCursor указывает на этот p
    const ids = s.result || [];
    seenTotal += s.total || ids.length;
    if ((s.total || 0) > ids.length) big[p] = s.total || 0;      // >100 id: пагинации нет
    for (const id of ids) (S.ids[id] || (S.ids[id] = {})).a = S.sweepId;   // свип эту позицию видит
    if (ids.length) { byPrice[p] = { ids: ids, id: s.id }; prices.push(p); }
    S.tabCursor = p + 1;
    p++;
  }
  const done = S.tabCursor > t.to;
  if (!done) notes.partial = true;
  if (notes.err) return;
  if (done && !probe) S.total = seenTotal;               // без триггера позиций столько, сколько нашли

  // Место в памяти кончается не здесь, а при записи в хранилище: guard живёт в
  // опросе (deflating) после диффа, чтобы этот дифф ещё видел имена позиций.

  // детали — только для позиций без них, пачками по 10 (потолок сайта на запрос)
  let got = 0;
  for (const p of prices) {
    const need = byPrice[p].ids.filter(function (id) { return !S.ids[id].i; });
    let i = 0;
    while (i < need.length) {
      if (got >= MAX_FETCH_PER_SWEEP) { notes.capped = true; break; }
      const chunk = need.slice(i, i + 10);
      const d = await tradeReq(ctx, S.lim.fetch,
        TR + "/fetch/" + chunk.join(",") + "?query=" + encodeURIComponent(byPrice[p].id), null, notes);
      if (!d) break;
      mergeListings(S, d);
      got++;                                   // считаются запросы, а не позиции
      i += 10;
    }
    if (notes.err || notes.capped) break;
  }

  // Вкладка, которая не влезла в один ответ сайта, недосчитаема в принципе: у поиска
  // нет пагинации (offset/page/view ничего не сдвигают), а разложить её по категориям
  // нельзя — у реальной жирной вкладки категория одна (проверено: category+price вместе
  // сайт принимает, но это делит по категориям товаров, а не по слотам таба). Считать
  // половину позиций значило бы рисовать ложные уход и находки при каждом свипе, поэтому
  // такая вкладка из диффа выпадает целиком, а карточка говорит, что её надо разбить.
  const bigTxt = {};
  for (const id in S.ids) {
    const e = S.ids[id];
    if (e.p && big[e.p] !== undefined) {
      e.b = 1;                                   // вкладку нельзя перечислить целиком
      if (!bigTxt[e.p]) bigTxt[e.p] = { n: big[e.p], t: e.t || ("~price " + e.p) };
    } else if (e.a === S.sweepId) delete e.b;    // в этом свипе её видно целиком
  }
  for (const q in big) if (!bigTxt[q]) bigTxt[q] = { n: big[q], t: "~price " + q };
  S.big = bigTxt;

  // Позиции, которые законченный снимок больше не видит, убираем из кэша. Чистка —
  // строго после диффа: до него позиция ещё должна быть с именем, стопкой и ценой,
  // иначе её уход запишется «? -16» и божественные не вычтутся.
  const complete = done && !notes.err && !notes.capped;
  if (!complete) notes.partial = true;
  S.lagMin = lagMinutes(S);
  // Только полный снимок закрывает базу: с него начинается отсчёт находок. Частичный
  // (обрванный на лимите) не даёт права считать всё новое находкой.
  if (commitSnapshot(S, notes, complete ? S.sweepId : null)) S.baseline = false;
  if (complete) {
    // Позиции невлезших вкладок не чистим: их свип не видел не потому, что их нет.
    for (const id in S.ids) if (S.ids[id].a !== S.sweepId && !S.ids[id].b) delete S.ids[id];
    // prevFullTs — снимок, который был перед этим: по нему видно, что про конец
    // забега вкладка уже успела спросить дважды.
    S.prevFullTs = S.fullTs || 0;
    S.fullTs = Date.now();
    S.tabCursor = 0;
  }
}

// Раскладка прихода по забегам: ищет забег, чьё окно накрывает дату индексации.
function runAt(st, t) {
  if (st.run && (!t || (t >= st.run.startTs - ATTR_TOL_MS && t <= Math.max(st.lastTs, st.maxTs) + ATTR_TOL_MS))) return st.run;
  for (const r of st.runs) if (t >= r.startTs - ATTR_TOL_MS && t <= r.endTs + ATTR_TOL_MS) return r;
  return null;
}

// Счётчики принадлежат сессии, а не объекту стеша: два опроса (лог и вкладки) живут
// каждый в своём темпе, и карточка находок обязана показывать верное, независимо от
// того, кто из неё последний рисовал. Ключ — время начала сессии (тот же sess у забега).
function sessEntry(S, sess) {
  const k = String(sess || 0);
  return S.sessDiv[k] || (S.sessDiv[k] = { div: 0, pos: 0, uns: 0 });
}

function trimSess(S) {
  const ks = Object.keys(S.sessDiv);
  if (ks.length <= 8) return;
  ks.sort(function (a, b) { return Number(a) - Number(b); });
  for (const k of ks.slice(0, ks.length - 8)) delete S.sessDiv[k];
}

function applyDeltas(st, S, notes) {
  for (const g of notes.gains) {
    if (g.nt) {                                          // содержимое свежей вкладки — не лут
      notes.tabNew = (notes.tabNew || 0) + g.n;
      if (!notes.tabName) notes.tabName = g.tab;
      continue;
    }
    const run = runAt(st, g.t);
    const e = sessEntry(S, run ? run.sess : S.sess);
    if (g.pos > 0) e.pos++;
    if (g.item !== DIVINE) continue;
    e.div += g.n;
    if (!run) { e.uns += g.n; continue; }
    const key = runKey(run);
    S.runDiv[key] = (S.runDiv[key] || 0) + g.n;
    const keys = Object.keys(S.runDiv);
    if (keys.length > 60) delete S.runDiv[keys[0]];
  }
  for (const l of notes.losses) {
    // Уход заметят не раньше, чем сайт проиндексирует пустоту: время снимка — это
    // «сейчас», а предмет в последний раз видели раньше. Окно ищем сначала по
    // последней видимости: иначе уход попадает в текущий (ещё не закрытый) забег,
    // его расходник «закрывается» чужим уходом, а минус ложится на счёт забега,
    // который к этому уходу непричастен.
    const run = (l.seen ? runAt(st, l.seen) : null) || runAt(st, l.t);
    const e = sessEntry(S, run ? run.sess : S.sess);
    if (l.pos < 0) e.pos--;
    if (l.item === DIVINE) e.div += l.n;                 // отрицательное: предмет ушёл
    if (!run) continue;
    const key = runKey(run);
    const m = S.runLoss[key] || (S.runLoss[key] = {});
    m[l.item] = (m[l.item] || 0) - l.n;
    if (l.item === DIVINE) S.runDiv[key] = (S.runDiv[key] || 0) + l.n;   // диван ушёл — минус по забегу
    // Санитайзер №1: эта валюта в забеге не тратится, значит её уход — трейд или
    // крафт в диффе. Забег помечается; при autoRules он выпадет из средних.
    if (NOT_SPENDABLE_IN_MAPS.indexOf(l.item) >= 0)
      S.susp[key] = l.item + " ушёл из вкладок во время забега — похож на трейд/крафт";
  }
  trimSess(S);
  trimRuns(S);
}

// Пометки и счётчики по забегам не должны разрастаться: хранятся только последние
// 60 забегов (столько же живёт и история забегов в состоянии лога).
function trimRuns(S) {
  for (const map of [S.runDiv, S.runLoss, S.susp]) {
    const ks = Object.keys(map || {});
    if (ks.length <= 60) continue;
    for (const k of ks.slice(0, ks.length - 60)) delete map[k];
  }
}

function newStash() {
  return { lim: null, ids: {}, snap: null, baseline: true, total: -1, probeId: null,
           fullTs: 0, league: "", leagueTs: 0, sessDiv: {}, err: "", big: {},
           runDiv: {}, runLoss: {}, susp: {}, thr: 0, lagMin: 0, sess: 0, sweepTs: 0, tabTxt: "",
    bigScan: null, prevFullTs: 0,
    tabCursor: 0, sweepId: 0, sweepFrom: 0, sweepTo: 0 };
}

// Ключ «stash» принадлежит только опросу вкладок, ключ «state» — только опросу лога.
// Трейд-цикл ждёт сети секунды, и писать он должен своё: иначе он вернулся бы и
// записал состояние лога таким, каким его застал, выбросив события, пришедшие пока
// он ждал ответ сайта.
function stashOf(ctx) {
  const base = newStash();
  const raw = ctx.storage.get("stash");
  const S = raw && typeof raw === "object" ? raw : newStash();
  for (const k in base) if (S[k] === undefined) S[k] = base[k];
  const lim = S.lim && typeof S.lim === "object" ? S.lim : {};
  S.lim = { search: bucket(lim.search, SEARCH_RULES), fetch: bucket(lim.fetch, FETCH_RULES) };
  return S;
}

function runKey(run) { return run.sess + "|" + run.areaId + "|" + (run.seed === null ? "" : run.seed); }

// Стоимость забега переживает пересборку сессии: ключ — (id карты, зерно), он не
// зависит от того, с какой метки началась сессия на этот раз.
function chargedCosts(st) {
  const c = {};
  for (const r of st.runs) if (r.costDiv !== undefined) c[r.areaId + "|" + (r.seed === null ? "" : r.seed)] = r.costDiv;
  return c;
}
function restoreCosts(st, charged) {
  for (const r of st.runs) {
    const k = r.areaId + "|" + (r.seed === null ? "" : r.seed);
    if (charged[k] !== undefined) r.costDiv = charged[k];
  }
}

function fmtDiv(x) { return String(Math.round(x * 10) / 10); }

// со знаком: расход тоже виден, и «+-16 div» на карточке читать нельзя
function signed(x) { return (x >= 0 ? "+" : "") + fmtDiv(x); }

// ---- карточки ----------------------------------------------------------------

function cut(s, n) { return s.length > n ? s.slice(0, n) : s; }

function render(ctx, st, c, S, tick) {
  const now = Math.max(st.lastTs, st.maxTs);
  const k = counts(st, c);
  // Окно темпа не короче 15 минут: забег за минуту не должен рисовать «60/час».
  const hours = Math.max(k.wallMs / 3600000, 0.25);
  const m = money(st, S, costCfg(ctx), k);
  const netHour = m.net / hours;

  ctx.cards.zone.set(st.zone
    ? { line1: cut(st.zone.name, 38), line2: KIND_LABEL[st.zone.kind] + " · с " + hhmm(st.zone.at) }
    : { line1: "нет известных зон", line2: "хвост прочитан, зон не видно" });

  if (st.run) {
    ctx.cards.map.set({
      line1: cut(st.run.name, 38),
      line2: "в забеге " + hms(k.openMs),
      badge: KIND_LABEL[st.run.kind],
      detail: st.run.areaId + (st.run.seed ? " seed " + st.run.seed : ""),
    });
  } else {
    const last = st.runs.length ? st.runs[st.runs.length - 1] : null;
    ctx.cards.map.set({ line1: "нет забега",
                        line2: last ? "последний: " + cut(last.name, 20) + " · " + hms(last.segMs) : "карт ещё не было" });
  }

  ctx.cards.session.set({
    title: "PoE2 · фарм",
    elapsedSec: Math.floor(k.wallMs / 1000),
    sub: "карт " + k.runs.length,
  });

  ctx.cards.stats.set({
    line1: "карт " + k.runs.length,
    line2: "в картах " + hms(k.mapMs) + " · средняя " + hms(k.runs.length ? k.mapMs / k.runs.length : 0),
  });

  // Лут текущей сессии: карточка есть, как только учёт включался — снимок построен,
  // или база ещё строится, или сказать нечего кроме причины (403, 429, нет связи).
  // Пока сайт не проиндексировал самое свежее, цифры за последние минуты неполные —
  // о лаге говорит вторая строка.
  if (st.session && S && (S.snap || S.err || S.total >= 0)) {
    const e = S.sessDiv[String(st.session.start)] || { div: 0, pos: 0, uns: 0 };
    ctx.cards.loot.set({
      line1: signed(e.div) + " div · " + signed(e.pos) + " позиц.",
      line2: cut((S.err ? S.err
                   : S.baseline ? "база вкладок строится"
                   : bigFirst(S) ? "не влезает таб: " + bigFirst(S).t
                   : S.lagMin > 2 ? "индексация отстаёт на " + S.lagMin + " мин"
                   : "вкладки проиндексированы"), 60) +
               (m.sus ? " · ⚠ " + m.sus : ""),
      badge: e.uns ? signed(e.uns) + " div вне карт" : "",
    });
  }

  ctx.cards.rate.set({ label: "Темп за " + hms(k.wallMs), number: Math.round(k.runs.length / hours),
                       unit: "заб/ч", min: 0, max: 10 });

  // Чистый доход: валовой лут минус затраты (планшет с амортизацией + расходники).
  // Если сетапа затрат нет, нетто равняется валовому — карточка об этом и молчит,
  // и не выдумывает расход. Подозрительные забеги из средних выпадуют (autoRules),
  // при выключенных правилах остаются, но их видно по числовым средним.
  ctx.cards.net.set({ label: "Нетто за " + hms(k.wallMs) + (m.sus ? " · ⚠" + m.sus : ""),
                      number: Math.round(netHour), unit: "div/ч", min: 0, max: 100 });
  // Кривая — нетто в час по времени. Точки кладет только опрос лога, иначе за цикл
  // рисовалось бы по две. HIST режет 0..255, диванов в час там и не бывает больше —
  // масштабировать нечем, только обрезаем снизу и сверху.
  ctx.cards.curve.set({ label: "Нетто, div/ч" + (m.sus ? " · ⚠" + m.sus : ""),
                        number: Math.round(Math.max(0, netHour)), unit: "div/ч",
                        windowSec: 90 * 60 });
  if (tick && st.session) ctx.cards.curve.history(Math.max(0, Math.min(255, Math.round(netHour))));
  return m;
}

// ---- плагин ------------------------------------------------------------------

definePlugin({
  cards: {
    zone: { label: "Зона", type: "status" },
    map: { label: "Забег", type: "status" },
    session: { label: "Сессия фарма", type: "session" },
    stats: { label: "Итоги сессии", type: "status" },
    rate: { label: "Темп фарма", type: "gauge" },
    loot: { label: "Лут с вкладок", type: "status" },
    net: { label: "Чистый доход", type: "gauge" },
    curve: { label: "Доход по времени", type: "spark" },
  },

  // Ручная правка забегов: форма настроек показывает подозрительные забеги
  // (санитайзеры или глаз человека), выбранное попадает в `excluded` и из средних
  // выпадает; крестик в строке возвращает забег обратно.
  providers: {
    listRuns(ctx) {
      const st = loadState(ctx), S = stashOf(ctx), cc = costCfg(ctx);
      const sess = st.session ? st.session.start : (st.finished ? st.finished.start : 0);
      const out = [];
      for (const r of st.runs) {
        if (r.sess !== sess) continue;
        const key = runKey(r);
        const nv = ((S.runDiv || {})[key] || 0) - (r.costDiv || 0);
        const why = (S.susp || {})[key] || (cc.excluded.indexOf(key) >= 0 ? "исключён вручную" : "");
        out.push({
          id: key,
          label: r.name + " · " + fmtDiv(nv) + " div · " + hms(r.segMs),
          detail: why || "чисто",
        });
      }
      return out;
    },
    checkCosts(ctx) {
      const cc = costCfg(ctx);
      if (!cc.tabletCost && !cc.items.length)
        return { ok: true, text: "затрат нет — доход показывается валовым" };
      const per = (cc.tabletCost ? cc.tabletCost / Math.max(1, cc.tabletUses) : 0) +
                  cc.items.reduce(function (a, x) { return a + x.div; }, 0);
      return { ok: true, text: "на забег: " + fmtDiv(per) +
               " div (планшет " + fmtDiv(cc.tabletCost / Math.max(1, cc.tabletUses)) +
               " из " + cc.tabletCost + " на " + cc.tabletUses + ") · порог выброса " +
               fmtDiv(cc.maxDiv) + " div" };
    },
  },

  activate(ctx) {
    ctx.poll(async function () {
      const c = settings(ctx);
      const st = loadState(ctx);
      scrubNames(st);              // битые имена из прошлых опросов не должны остаться на панели
      const notes = { rollback: false, sessionClosed: false, silence: false, quiet: false };

      const wantBig = !!st.escalate;                       // предыдущий опрос не покрыл лог
      let res = await readTail(ctx, wantBig, st);
      if (res.err) {
        logBad = res.err;
        // Карточка говорит коротко (вторая строка ограничена 71 байтом), а статус —
        // целиком: с какой папкой плагин бился и что ответила команда.
        ctx.cards.zone.set({ line1: "нет доступа к логу", line2: res.short || "смотри статус" });
        // Оценка средней длины строки рождается именно здесь (после обрезки вывода), и
        // её надо сохранить: опрос с ошибкой дальше ничего не пишет, а без записи
        // следующая попытка была бы ровно такой же — 1200 строк, снова обрезок.
        ctx.storage.set("state", st);
        return res.err + " · папка: " + String(ctx.settings.get("logDir") || "не задана");
      }

      logBad = res.mangled ? "лог пришёл не в UTF-8: имена зон не читаются" : "";
      let first = null;
      for (const line of res.lines) { const t = stamp(line); if (t !== null) { first = t; break; } }
      // Первая размеченная строка хвоста позже последней обработанной ⇒ хвост не
      // покрыл новые строки. В этом опросе честно говорим о пропуске, следующий
      // читаем большим хвостом (4000 строк).
      const missed = !!st.lastTs && first !== null && first > st.lastTs;

      if (missed) {
        st.gapSec = Math.round((first - st.lastTs) / 1000);
        st.escalate = true;
        feed(st, res.lines, c, notes, false);              // видимое всё равно считаем
      } else if (wantBig && st.session && first !== null && first <= st.session.start) {
        // большой хвост покрыл сессию целиком — пересобираем её с нуля, иначе уже
        // посчитанные события задвоятся
        const fresh = blank();
        const tbKey = st.tabletKey, tbLeft = st.tabletLeft; // учёт планшета — не часть сессии
        // Стоимость забега фиксирована один раз: пересобранная сессия обязана
        // застать её готовой, иначе забег оплатит планшет и расходники дважды.
        const charged = chargedCosts(st);
        notes.quiet = true;              // пересборка не должна заново сыпать тостами
        feed(fresh, res.lines, c, notes);
        copyInto(st, fresh);
        st.tabletKey = tbKey; st.tabletLeft = tbLeft;
        restoreCosts(st, charged);
        st.escalate = false; st.gapSec = 0;
      } else {
        feed(st, res.lines, c, notes);
        if (wantBig) { st.escalate = false; st.gapSec = 0; }   // разрыв закрыт
      }

      const S0 = stashOf(ctx);
      chargeRuns(st, costCfg(ctx), S0, tradeCfg(ctx).on);
      render(ctx, st, c, S0, true);
      // 256 КБ на плагин делятся с учётом вкладок: если запись не влезла,
      // освобождаем своё и пробуем ещё раз. Иначе следующий опрос перечитал бы
      // старое состояние и посчитал те же строки лога заново (ложный «откат
      // времени» и задвоенные забеги).
      let saved = ctx.storage.set("state", st);
      if (!saved) {
        if (st.runs.length > 10) st.runs.splice(0, st.runs.length - 10);
        if (st.seen.length > 2000) st.seen.splice(0, st.seen.length - 2000);
        saved = ctx.storage.set("state", st);
      }

      // Тосты — только по новым событиям этого опроса: перекрывающийся хвост и
      // пересборка сессии не должны повторять уведомления.
      if (!notes.quiet && notes.sessionClosed) {
        const k = counts(st, c);
        const fin = money(st, S0, costCfg(ctx), k);
        ctx.toast("done", "Сессия окончена",
                  k.runs.length + " карт · " + hms(k.mapMs) + " в картах · нетто " +
                  signed(fin.net) + " div" + (fin.sus ? " · ⚠ " + fin.sus : ""));
      }

      const k = counts(st, c);
      if (st.escalate) return statusWith("пропущено ~" + Math.max(1, Math.round(st.gapSec / 60)) + " мин лога — беру большой хвост");
      if (notes.rollback) return statusWith("время в логе откатилось — сессия начата заново");
      const mo = money(st, S0, costCfg(ctx), k);
      // Потерять состояние молча — значит потом задвоить карты; об этом надо сказать.
      return statusWith((saved ? "" : "состояние не записано — кончилась память плагина · ") +
             "сессия " + hms(k.wallMs) + " · карт " + k.runs.length +
             " · нетто " + signed(mo.net) + " div" + (mo.sus ? " · ⚠ подозрительных " + mo.sus : ""));
    }, { everySetting: "pollSec" });   // интервал — из настройки, хост перевзводит сам

    // Меняем настройку — реагируем сразу, без перезапуска плагина (иначе хост
    // перезапускает плагин и текущая сессия теряется).
    ctx.settings.onChange(function () { /* настройки читаются на каждом опросе */ });

    // Второй опрос — вкладки стеша. Интервал отдельный (stashMinGapSec): сеть тут
    // дороже и медленнее, чем чтение хвоста лога, и свои лимиты.
    ctx.poll(async function () {
      const c = settings(ctx), t = tradeCfg(ctx);
      const st = loadState(ctx);
      const S = stashOf(ctx);
      const sessStart = st.session ? st.session.start : 0;
      // «текущая» сессия нужна лишь для находок вне забегов; сами счётчики лежат в
      // sessDiv по сессиям, поэтому обнулять при смене сессии нечего
      if (sessStart) S.sess = sessStart;
      if (!t.on) { ctx.storage.set("stash", S); return statusWith("учёт вкладок выключен или аккаунт не указан"); }

      const notes = { gains: [], losses: [], err: null, wait: 0,
                      capped: false, partial: false, resync: false };
      S.sweepTs = Date.now();
      await sweepStash(ctx, S, t, notes);
      S.err = notes.err || "";             // карточка обязана говорить, почему цифры вчерашние
      // состояние лога перечитывается после сети: пока ждали ответ сайта, опрос лога
      // мог закрыть забег или открыть новый — окна раскладки должны быть свежие,
      // иначе находка попадёт на карту, которой уже нет
      const st2 = loadState(ctx);
      if (st2.session) S.sess = st2.session.start;
      applyDeltas(st2, S, notes);
      markSuspects(st2, S, costCfg(ctx), counts(st2, c));
      deflating(S);
      // напоминание о новой вкладке живёт, пока следующий полный снимок ничего нового
      // не увидит: тост можно и пропустить
      if (notes.tabNew) S.tabTxt = "новая вкладка «" + notes.tabName + "» — её содержимое не лут";
      else if (!notes.partial && !notes.err && !notes.capped) S.tabTxt = "";
      let saved = ctx.storage.set("stash", S);
      // Дельты уже применены к S, но в хосте лежит прежний снимок. Оставляем в памяти
      // ровно то, что сохранено: иначе следующий свип сравнит находки с неснятым
      // снимком и посчитает тот же лут второй раз.
      if (!saved) S = stashOf(ctx);
      render(ctx, st2, c, S);

      // тост не чаще одного за свип: фарм не должен превращаться в пулемёт
      if (saved && notes.gains.length) {
        let div = 0, units = 0, name = "";
        for (const g of notes.gains) {
          if (g.nt) continue;                             // свежая вкладка — не находка
          units += g.n;
          if (g.item === DIVINE) div += g.n;
          if (!name && (g.f === "Unique" || g.f === "DivinationCard")) name = g.item;
        }
        if (units) {
          ctx.toast("notice", "Находки в стеше",
                    signed(div) + " div · " + signed(units) + " шт." + (name ? " · " + name : ""));
        }
      }
      if (notes.tabNew) {
        ctx.toast("notice", "Вкладка появилась",
                  "«" + notes.tabName + "» встала в поиск: " + notes.tabNew +
                  " поз. лутом не считаются");
      }
      if (!saved) return statusWith("позиций не влезает в память плагина — разбей вкладки (до 100 слотов) и сузь диапазон цен");
      if (notes.err) return statusWith(notes.err);
      if (notes.wait) return statusWith("trade2 держит паузу ~" + Math.ceil(notes.wait / 1000) + " с — лимит запросов");
      const cur = S.sessDiv[String(S.sess || 0)] || { div: 0, pos: 0, uns: 0 };
      const bits = ["позиций " + S.total, "div " + fmtDiv(cur.div), "лаг " + S.lagMin + " мин"];
      if (S.nameless) bits.push("имена забыты у " + S.nameless + " старых позиций — div и позиции считаются");
      if (notes.capped) bits.push("добор id остановлен лимитом свипа");
      const big = bigFirst(S);
      if (big) bits.push("вкладка «" + big.t + "» не влезает в поиск (" + big.n +
                         " поз.) — разбей, она не считается");
      if (S.tabTxt) bits.push(S.tabTxt);
      if (S.baseline) bits.push("база вкладок строится");
      return statusWith(bits.join(" · "));
    }, { everySetting: "stashMinGapSec" });
  },
});

function copyInto(dst, src) { for (const k in src) dst[k] = src[k]; }
