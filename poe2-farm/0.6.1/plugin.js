// «Фарм PoE2» — статистика игровой сессии Path of Exile 2 на панели Usee.
// ТЗ: usee-poe2-farm-tz.md. Два источника, оба без входа в аккаунт: хвост
// Client.txt (сессия, забег, зоны) и публичный поиск trade2 (что пришло в
// публичную вкладку, в божественных сферах).
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
  return {
    // 30 минут, а не 15: в реальном логе фарма паузы между строками доходят до
    // 11 минут (тихая карта без CRIT-шума), и сессия рвалась посреди забега.
    // Выход из игры помечает конец сам — пауза остаётся запасой для падения.
    gapMs: 30 * 60000,
    // Карта короче минуты — не забег, а шум лога (прогрузка, откат часов).
    minMs: 60000,
  };
}

// ---- доступ к логу -----------------------------------------------------------

// Лог читает сам агент (ctx.files, SDK 10): открыть файл в папке из настройки, прочитать с места,
// где остановились, — микросекунды. До 0.6 его читала команда powershell Get-Content -Tail раз в
// 5 с (≈ 0,4 с процессора на запуск, ≈ 8 % ядра всё время, пока плагин включён) — и вокруг неё жила
// машина «большого хвоста»: оценка длины строк, обрезанный вывод, эскалация пропусков. С чтением
// по смещению пропусков нет: всё, что игра дописала, прочитано ровно один раз.
// Читаем LatestClient.txt — лог текущего запуска: Client.txt за много вечеров дорастает до сотен
// мегабайт, и в его хвосте осколки прошлых сессий. Новый запуск игры — новый файл: агент узнаёт его
// по первой строке и отдаёт reset, чтение идёт с начала.
const LOG_NAME = "LatestClient.txt";
// Чтение — дешёвое, поэтому чаще, чем позволяла команда: зона на панели меняется через ~2 с после
// загрузки, а не через 5.
const LOG_POLL_SEC = 2;
// Вкладки: бюджет поиска trade2 с одного IP — 600 запросов на 6 часов (см.
// SEARCH_RULES), то есть свип не чаще одного в ~36 с. Берём 60 с: 360 свипов на
// 6-часовой фарм = 60% бюджета, остаток остаётся на перезапуски и перестройку базы.
// Теоретический минимум 40 с съедал бы 90% бюджета, и под конец длинного фарма
// трекер вставал бы на Retry-After ровно тогда, когда цифры нужнее всего.
const STASH_POLL_SEC = 60;
// За один опрос — до 8 кусков по 128 КБ: первый запуск берёт хвост (~700 строк), дальше — то,
// что дописано. Агент стоял долго (и лог убежал на мегабайты) — догоняем за несколько опросов.
const READ_CHUNK = 131072, READ_CHUNKS = 8;

async function readLog(ctx, st) {
  const lines = [];
  let reset = false;
  let n = 0;
  while (n++ < READ_CHUNKS) {                  // while, не for(let…): await в for(let…) роняет Jint (см. ниже)
    const pos = st.log;
    let r;
    try {
      r = await ctx.files.read(LOG_NAME, pos ? { from: pos.to, id: pos.id, max: READ_CHUNK } : { max: READ_CHUNK });
    } catch (e) {
      const why = typeof e === "string" ? e : (e && e.message) || "?";
      return { err: "лог не читается: " + why,
               short: why.indexOf("папк") >= 0 ? "папки нет" : why.indexOf("нет файла") >= 0 ? "нет файла лога" : "лог не читается" };
    }
    if (r.reset) reset = true;
    st.log = { id: r.id, to: r.to };
    if (r.text) for (const l of r.text.split(/\r?\n/)) if (l) lines.push(l);
    if (r.eof || !r.text) break;
  }
  return { lines: lines, reset: reset, mangled: lines.some(function (l) { return l.indexOf("\uFFFD") >= 0; }) };
}

// ---- машина состояний «сессия / забег» ---------------------------------------

const RUNS_CAP = 50;      // записей забегов в памяти и в storage
const SEEN_CAP = 4000;    // страховка; по-настоящему отпечатки чистятся по времени хвоста

function blank() {
  return { lastTs: 0, maxTs: 0, session: null, finished: null, run: null, runs: [], seen: [],
           log: null, pending: null, zone: null, lineTs: 0, curArea: "", histCut: 0 };
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

// Кормим состоянием новые строки лога. Чтение по смещению не перекрывается само с собой;
// отпечатки остаются на стыки, где перекрытие возможно: первый хвост после обновления с 0.5
// (её состояние уже видело часть этих строк) и хвост после потери позиции.
function feed(st, lines, c, notes) {
  // Событие раньше первой строки этой порции встретиться больше не может: всё, что старше,
  // выбрасываем, а кап по количеству остаётся страховкой.
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
    // Сам лог молчал дольше паузы сессии (30 минут, см. settings()) ⇒ игрок ушёл/
    // игра закрылась: сессия окончена. Дыр между СОБЫТИЯМИ не смотрим — карта
    // живёт минутами без строк.
    if (c.gapMs && st.lineTs && t - st.lineTs > c.gapMs && t > st.lineTs) {
      if (st.session) closeSession(st, st.lineTs, notes);
      notes.silence = true;
    }
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
  // «Сейчас» живой сессии — часы, пока лог свеж (последняя строка моложе паузы сессии): в тихой
  // карте лог молчит минутами, и время на панели стояло, а потом прыгало (ревью 04.11.2026).
  // Лог старый (агент читает чужой/прошлый, тесты) — время лога, как раньше.
  const wall = Date.now();
  const live = st.session && st.lineTs && wall >= st.lineTs && wall - st.lineTs < c.gapMs;
  const now = st.session ? Math.max(st.lastTs, st.maxTs, live ? wall : 0) : (st.finished ? st.finished.end : 0);
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
// публичной правым кликом в игре, а её ценой правит имя «~price <N> divine Метка».
// Фильтра по имени вкладки у поиска нет (имя видно только в ответе), зато число N
// из имени работает селектором: поиск «аккаунт + цена N» отдаёт ровно одну вкладку
// (проверено на живом аккаунте), поэтому число берём из настройки-имени и одним
// запросом снимаем свою вкладку. Тем, что найдено в других вкладках, учёт не
// пользуется — позиции чужих вкладок помечаются e.x и в дифф не попадают.
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
// Чем сейчас болен источник лога (пусто — читается). Статус плагина один, а опросов
// два: без этого флага добрый текст опроса вкладок перетирает сообщение «лога нет»,
// и на живом агенте карточка болела молча.
let logBad = "";
// Статус у плагина один, а опросов два. Без этого «последний» опроса панель каждые
// несколько секунд показывает то историю лога, то вкладки, и прочесть из этого
// что-то нельзя.
let stashNote = "";
function statusWith(extra) { return [logBad, extra, stashNote].filter(function (x) { return !!x; }).join(" · "); }

const DIVINE = "Divine Orb";

// Цены лута в divine — у poe.ninja (exchange overview: primaryValue — сколько divine стоит штука).
// 01.11.2026 там были только курсы трёх валют; с 04.11.2026 — около 600 позиций в 13 разделах
// (валюта, фрагменты, эссенции, руны, камни…). Раньше «доход в div» считал только стопки Divine
// Orb, а основной доход фарма PoE2 — экзальты и прочая валюта (ревью 04.11.2026). Предметы без
// цены (редкие, уникальные, путевые камни) в div не входят — статус говорит, сколько их.
// Таблица — раз в час, 13 запросов; цена берётся в момент находки.
const NINJA = "https://poe.ninja/poe2/api/economy/exchange/current/overview";
const NINJA_TYPES = ["Currency", "Fragments", "Essences", "Runes", "UncutGems", "Breach", "Delirium",
                     "Ritual", "Abyss", "Expedition", "Verisium", "LineageSupportGems", "SoulCores"];
const PRICES_TTL_MS = 3600000;

function pricesOf(ctx) {
  const p = ctx.storage.get("prices");
  return p && typeof p === "object" && p.div ? p : { at: 0, league: "", div: {} };
}

async function refreshPrices(ctx, league, notes) {
  const P = pricesOf(ctx);
  if (!league || (P.league === league && Date.now() - P.at < PRICES_TTL_MS)) return P;
  const div = {};
  let ok = 0;
  for (const type of NINJA_TYPES) {
    let r;
    try {
      r = await ctx.net.fetch(NINJA + "?league=" + encodeURIComponent(league) + "&type=" + type,
                              { headers: { "user-agent": UA } });
    } catch (e) { continue; }
    if (!r.ok) continue;
    let j;
    try { j = r.json(); } catch (e) { continue; }
    const names = {};
    for (const it of (j && j.items) || []) if (it && it.id && it.name) names[it.id] = it.name;
    for (const l of (j && j.lines) || []) {
      const n = names[l.id], v = Number(l.primaryValue);
      if (n && isFinite(v) && v > 0) div[n] = Math.round(v * 1e6) / 1e6;
    }
    ok++;
  }
  if (!ok) { notes.priceErr = "цены poe.ninja не получены — в div только Divine"; return P; }
  div[DIVINE] = 1;
  const next = { at: Date.now(), league: league, div: div };
  ctx.storage.set("prices", next);
  return next;
}

// Цена штуки в divine; null — цены нет.
function unitDiv(P, item) {
  if (item === DIVINE) return 1;
  const v = P && P.div ? P.div[item] : undefined;
  return typeof v === "number" ? v : null;
}
const FRESH_IDS = 10;               // сколько самых свежих позиций обновляем каждый цикл
const BUCKET_MS = 600000;           // точка графика дохода = 10 минут (90 точек = 15 часов)
const TOAST_EVERY_MS = 600000;      // тост о находках — не чаще раза в 10 минут (или с 1 div)
const IDLE_SWEEP_MS = 600000;       // без фарма — свип вкладок раз в 10 минут

// Вкладка опознаётся по имени из ответа сайта. Пользователь может написать имя
// целиком или его короткую метку («usee»), поэтому совпадение — по ЦЕЛЫМ СЛОВАМ:
// «usee» признаёт «~price 999 divine usee», но не признаёт «~price 999 divine
// usee2». Подстрока призн бы чужую вкладку своей, а её лут — своим доходом.
function normTab(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }
function sameTab(got, want) {
  const a = normTab(got).split(" "), b = normTab(want).split(" ");
  if (!b[0]) return true;                         // вкладку не указали: берём всё найденное
  if (!a[0]) return false;                        // имени нет — решает полоса цены
  const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
  for (let i = 0; i + short.length <= long.length; i++) {
    let ok = true;
    for (let j = 0; j < short.length; j++) { if (long[i + j] !== short[j]) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}
// Позиция принадлежит НЕ нашей вкладке: цена вне полосы нашей вкладки либо имя
// не совпало. Имя мог съесть deflating (старые позиции без имени) — тогда решает
// полоса цены, а не догадка.
function foreignTab(e, t) {
  if (e.p && (e.p < t.from || e.p > t.to)) return true;
  return !!e.t && !sameTab(e.t, t.tab);
}

function tradeCfg(ctx) {
  const acc = String(ctx.settings.get("tradeAccount") || "").trim();
  // Вкладка ищется по имени: «~price 999 divine usee». Число из имени — полоса
  // поиска (один запрос на вкладку); без числа снимаем 990…999 и отбираем по имени.
  const tab = String(ctx.settings.get("tabName") || "").trim();
  const m = /~price\s+(\d+)\s+divine/i.exec(tab);
  return {
    // без аккаунта запросов нет вовсе: угадывать ник плагин не будет
    on: /^\S+#\d{4}$/.test(acc),
    account: acc,
    tab: tab,
    from: m ? +m[1] : 990,
    to: m ? +m[1] : 999,
    league: String(ctx.settings.get("league") || "").trim(),
    fullMs: 15 * 60000,
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

// Поиск без ценовой полосы: «есть ли у аккаунта публичные лоты в этой лиге».
function probeBody(acc) {
  return JSON.stringify({
    query: { status: { option: "any" },
             filters: { trade_filters: { filters: { account: { input: acc } } } } },
    sort: { indexed: "desc" },
  });
}

// Лига (настройка пустая = авто). Брать «первую лигу сайта» нельзя: первой в списке
// идёт текущая временная лига, а аккаунт может играть в постоянной (Standard). Поиск
// по аккаунту в чужой лиге даёт ноль, и цифры просто не появляются — это уже случилось
// на живой панели. Поэтому лигу ищем по факту: где у аккаунта есть публичные лоты.
async function leagueOf(ctx, S, t, notes) {
  // Лигу из настройки храним и в S.league: иначе статус показывает лигу прошлого
  // автопоиска, пока поиск идёт по лиге, вписанной руками (на живой панели это
  // выглядело как «автоопределение не работает»).
  if (S.leagueSet !== t.league) { S.leagueSet = t.league; S.league = ""; }
  if (t.league) { S.league = t.league; S.leagueGuess = false; return t.league; }
  // догадку перепроверяем чаще (10 мин), удачное попадание — раз в сутки
  if (S.league && Date.now() - S.leagueTs < (S.leagueGuess ? 600000 : 86400000)) return S.league;
  const j = await tradeReq(ctx, S.lim.search, TR + "/data/leagues", null, notes);
  if (!j || !Array.isArray(j.result)) return S.league || "";
  const soft = [], perm = [];
  for (const e of j.result) {
    if (e.realm && e.realm !== "poe2") continue;
    if (/^(HC |Ruthless)/.test(e.id)) continue;
    (/^(Standard|Hardcore)$/.test(e.id) ? perm : soft).push(e.id);
  }
  for (const lg of soft.concat(perm)) {
    const q = await tradeReq(ctx, S.lim.search, TR + "/search/poe2/" + encodeURIComponent(lg),
                             probeBody(t.account), notes);
    if (q && (q.total || 0) > 0) {
      S.league = lg; S.leagueTs = Date.now(); S.leagueGuess = false;
      return lg;
    }
  }
  // нигде пусто: либо вкладки не публичные, либо опечатка в имени аккаунта. Лигу
  // оставляем первую попавшуюся и помечаем догадку — статус обязан это сказать.
  S.leagueTs = Date.now();
  if (!S.league && soft.length) S.league = soft[0];
  S.leagueGuess = true;
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
// только подпись в тосте «что пришло».
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
    if (!e.i || e.x) continue;              // чужую вкладку не считаем вовсе
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
      if (e.x) continue;                    // чужая вкладка: её уход — не наш расход
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
  //
  // Здесь же отсекаются чужие вкладки: позиция с другой ценой или с другим именем в
  // учёт не входит вовсе. Без этого чужой лот в соседней вкладке или переименование
  // своей выглядели бы нашим доходом, а их исчезновение — нашим расходом.
  const bigTxt = {}, others = [];
  let mine = 0;
  for (const id in S.ids) {
    const e = S.ids[id];
    // Забытое имя вкладки (deflating) не имеет права превращать чужое в своё:
    // раз позиция уже была помечена чужой, а проверить нечем — остаётся чужой.
    // Иначе на тесноте памяти мы бы начали выдумывать находки и расходы.
    if (foreignTab(e, t) || (e.x && !e.t)) {
      e.x = 1;
      if (e.t && others.indexOf(e.t) < 0) others.push(e.t);
      continue;
    }
    delete e.x;
    if (e.a === S.sweepId) mine++;
    if (e.p && big[e.p] !== undefined) {
      e.b = 1;                                   // вкладку нельзя перечислить целиком
      if (!bigTxt[e.p]) bigTxt[e.p] = { n: big[e.p], t: e.t || ("~price " + e.p) };
    } else {
      // На ПРОШЛОМ свипе эта полоса не влезала в ответ (S.big ещё прежний), а теперь
      // видна целиком: её хвост раньше нельзя было увидеть в принципе, поэтому
      // впервые показавшиеся позиции — не находка фарма. Без этого вкладка,
      // которую пользователь разбил (или которая усохла), рисуется доходом.
      if (S.snap && S.big && e.p && S.big[e.p] !== undefined && S.snap[id] === undefined)
        S.snap[id] = e.s || 1;
      if (e.a === S.sweepId) delete e.b;         // в этом свипе её видно целиком
    }
  }
  for (const q in big) if (!bigTxt[q]) bigTxt[q] = { n: big[q], t: "~price " + q };
  S.big = bigTxt;
  S.tabs = others.slice(0, 3).join(", ");

  // Позиции, которые законченный снимок больше не видит, убираем из кэша. Чистка —
  // строго после диффа: до него позиция ещё должна быть с именем, стопкой и ценой,
  // иначе её уход запишется «? -16» и божественные не вычтутся.
  const complete = done && !notes.err && !notes.capped;
  if (!complete) notes.partial = true;
  S.lagMin = lagMinutes(S);
  // Только полный снимок закрывает базу: с него начинается отсчёт находок. Частичный
  // (обрванный на лимите) не даёт права считать всё новое находкой.
  if (commitSnapshot(S, notes, complete ? S.sweepId : null)) S.baseline = false;
  S.mine = mine;
  if (complete) S.noTab = mine ? 0 : 1;
  if (complete) {
    // Позиции невлезших вкладок не чистим: их свип не видел не потому, что их нет.
    for (const id in S.ids) if (S.ids[id].a !== S.sweepId && !S.ids[id].b) delete S.ids[id];
    S.fullTs = Date.now();
    S.tabCursor = 0;
  }
}

// Счётчики принадлежат сессии, а не объекту стеша: два опроса (лог и вкладки) живут
// каждый в своём темпе, и карточка находок обязана показывать верное, независимо от
// того, кто из неё последний рисовал. Ключ — время начала сессии (тот же sess у забега).
// Ключ сессии фарм-логики: живая сессия или та, что только что закрылась. Счётчики
// лута пишутся по этому же ключу — иначе находки, пришедшие после закрытия игры,
// падают в «0», а карточка читает другую запись и показывает +0 div.
function logSessOf(st) { return st.session ? st.session.start : (st.finished ? st.finished.start : 0); }

function sessEntry(S, sess) {
  const k = String(sess || 0);
  return S.sessDiv[k] || (S.sessDiv[k] = { div: 0, pos: 0 });
}

function trimSess(S) {
  const ks = Object.keys(S.sessDiv);
  if (ks.length <= 8) return;
  ks.sort(function (a, b) { return Number(a) - Number(b); });
  for (const k of ks.slice(0, ks.length - 8)) delete S.sessDiv[k];
}

// Окна графика — по 10 минут: и находка, и уход ложатся в окно того свипа, который
// их увидел. По окну наблюдения, а не по дате индексации: сайт индексирует вкладки с
// лагом в 5…15 минут, и окно своей индексации находка могла бы попасть в уже
// нарисованную точку графика, то есть на панель бы ничего не пришло.
function addHist(S, at, div) {
  if (!at || !div) return;
  const k = String(Math.floor(at / BUCKET_MS) * BUCKET_MS);
  S.hist[k] = (S.hist[k] || 0) + div;
}

function trimHist(S) {
  const ks = Object.keys(S.hist);
  if (ks.length <= 90) return;
  ks.sort(function (a, b) { return Number(a) - Number(b); });
  for (const k of ks.slice(0, ks.length - 90)) delete S.hist[k];
}

function applyDeltas(S, notes, P) {
  const e = sessEntry(S, S.sess);
  notes.gainDiv = 0; notes.gainItems = 0;
  for (const g of notes.gains) {
    if (g.nt) {                                          // содержимое свежей вкладки — не лут
      notes.tabNew = (notes.tabNew || 0) + g.n;
      if (!notes.tabName) notes.tabName = g.tab;
      continue;
    }
    if (g.pos > 0) e.pos++;
    notes.gainItems += g.n;
    const u = unitDiv(P, g.item);
    if (u === null) { e.unpriced = (e.unpriced || 0) + 1; continue; }
    e.div += g.n * u;
    notes.gainDiv += g.n * u;
    addHist(S, S.sweepTs, g.n * u);
  }
  for (const l of notes.losses) {
    if (l.pos < 0) e.pos--;
    const u = unitDiv(P, l.item);
    if (u === null) continue;
    e.div += l.n * u;                                    // отрицательное: предмет ушёл
    addHist(S, S.sweepTs, l.n * u);
  }
  trimSess(S);
  trimHist(S);
}

function newStash() {
  return { lim: null, ids: {}, snap: null, baseline: true, total: -1, probeId: null,
           fullTs: 0, league: "", leagueTs: 0, leagueGuess: false,
           sessDiv: {}, hist: {}, err: "", big: {}, bigScan: null, lagMin: 0, sess: 0,
           sweepTs: 0, sweepId: 0, sweepFrom: 0, sweepTo: 0, tabCursor: 0,
           tabTxt: "", tabs: "", noTab: 0, mine: 0, nameless: 0, leagueSet: "", priceErr: "", toastQ: null };
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
  // Счётчиков по забегам и порога выброса в учёте больше нет, но их старые записи
  // после обновления плагина всё ещё лежат в хранилище и жрут место, отведённое
  // позициям вкладок.
  for (const k of ["runDiv", "runLoss", "susp", "thr", "histCut", "prevFullTs"]) delete S[k];
  const lim = S.lim && typeof S.lim === "object" ? S.lim : {};
  S.lim = { search: bucket(lim.search, SEARCH_RULES), fetch: bucket(lim.fetch, FETCH_RULES) };
  return S;
}

// Доход теперь дробный (экзальт ≈ 0,0014 div): меньше 10 — два знака, больше — один.
function fmtDiv(x) { return String(Math.abs(x) < 10 ? Math.round(x * 100) / 100 : Math.round(x * 10) / 10); }

// со знаком: расход тоже виден, и «+-16 div» на карточке читать нельзя
function signed(x) { return (x >= 0 ? "+" : "") + fmtDiv(x); }

// ---- карточки ----------------------------------------------------------------

// Статус-карточка живёт строками: line1 — 39 байт, line2 — 71. Обрезаем по байтам
// UTF-8, а не по символам: иначе русская подпись обрежется посреди буквы, и панель
// нарисует мусор вместо причины.
function cutB(s, limit) {
  const cps = Array.from(String(s));
  let out = "", used = 0, i = 0;
  for (; i < cps.length; i++) {
    const w = utf8len(cps[i]);
    if (used + w > limit) break;
    out += cps[i]; used += w;
  }
  if (i < cps.length) {
    // не влезло: убираем символы, пока не станет места под многоточие — «Убежище
    // в зиккурате…» читается как «не влезло», а не как оборванная буква
    while (i > 0 && used + 3 > limit) { i--; used -= utf8len(cps[i]); out = out.slice(0, out.length - cps[i].length); }
    if (used + 3 <= limit) { out += "…"; used += 3; }
  }
  return out;
}

function utf8len(s) { let n = 0; for (const c of String(s)) { const k = c.codePointAt(0); n += k < 0x80 ? 1 : k < 0x800 ? 2 : k < 0x10000 ? 3 : 4; } return n; }

// Почему цифрам по вкладкам нельзя верить. Пустая строка = цифры полные.
function lootProblem(S, t, live) {
  if (!t.on) return "аккаунт не указан — по вкладкам не считаем";
  if (S.err) return S.err;
  if (S.leagueGuess) return "у аккаунта нет публичных лотов";
  if (S.noTab) return t.tab ? "вкладка «" + t.tab + "» не найдена"
                            : "у аккаунта нет публичных вкладок 990…999";
  if (S.baseline) return "база вкладок строится";
  if (S.priceErr) return S.priceErr;
  const b = bigFirst(S);
  if (b) return "вкладка «" + b.t + "» не влезает — не считается";
  // Отставание индексации — беда, пока фарм идёт: свежий лот мог ещё не попасть в
  // поиск, и цифра ниже настоящей. Если смены нет (или она кончилась час назад),
  // вчерашний индекс — не ошибка: вкладки просто не менялись, и всю неделю
  // говорить «цифрам не верь» не за что.
  if (S.lagMin > 2 && live) return "индексация отстаёт на " + S.lagMin + " мин";
  return "";
}

// Лог «живой» — его последняя строка по часам этого ПК не старше двух суток: тогда время лога
// и часы сравнимы. Старый или чужой файл (и тесты на логах 2025 года) таких решений не получает.
function logIsLive(st) {
  const age = Date.now() - (st.lineTs || 0);
  return !!st.lineTs && age >= 0 && age < 2 * 86400000;
}

function liveWatch(st) {
  return !!st.session || !!(st.finished && Date.now() - st.finished.end < 3600000);
}

// Точку графика кладёт только опрос лога, иначе за цикл рисовалось бы по две.
// Окно закрылось — точка вышла: одна точка на окно (10 минут), значение — div/ч
// в этом окне. HIST режет 0..255 целыми, поэтому потолок точки — 42 div за окно
// (255 div/ч): больше фарм не показывает, но и вранья нет — карточка «Итоги»
// считает сколько угодно.
// histCut живёт в состоянии лога: ключ «stash» пишет только опрос вкладок,
// и отсчётную метку истории лог-опрос иначе бы не сохранил и рисовал
// одно и то же окно повторно.
function emitCurve(ctx, st, S) {
  const b = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  if (!st.histCut) { st.histCut = b; return; }        // историю не выдумываем
  // Окна, за которыми трекер вкладок вообще не следил (аккаунт не указан, база ещё
  // не построена), — не «ноль дохода», а «мы не смотрели»: точка в таком окне
  // была бы нарисованной правдой про наблюдение, которого не было.
  if (!(S && S.snap)) { st.histCut = b; return; }
  // Окна длиннее всей истории — это не «ноль дохода», это «нас не было»: агент
  // стоял выключенный или панель не вещала. Рисовать по таким окнам нули — значит
  // нарисованную правду про часы, которых плагин не видел, поэтому история
  // начинается заново, а не заполняется молчанием.
  if (b - st.histCut > 90 * BUCKET_MS) { st.histCut = b; return; }
  while (st.histCut + BUCKET_MS <= b) {
    const v = ((S.hist || {})[String(st.histCut)] || 0) * (3600000 / BUCKET_MS);
    ctx.cards.curve.history(Math.max(0, Math.min(255, Math.round(v))));
    st.histCut += BUCKET_MS;
  }
}

function render(ctx, st, c, S, tick, t) {
  const k = counts(st, c);
  // Окно темпа не короче 15 минут: сессия на пять минут с двумя диванами не должна
  // рисовать «24 div/ч».
  const hours = Math.max(k.wallMs / 3600000, 0.25);
  const e = (S && S.sessDiv[String(logSessOf(st))]) || { div: 0, pos: 0 };

  // Имя зоны режется ПО БАЙТАМ UTF-8: прошивка хранит line1[40], и «Убежище в
  // зиккурате Утробы» (52 байта) обрезалось бы посреди буквы — те же квадраты, что
  // дала cp866-кодировка, только с другой стороны.
  ctx.cards.zone.set(st.zone
    ? { line1: cutB(st.zone.name, 39), line2: cutB(KIND_LABEL[st.zone.kind] + " · с " + hhmm(st.zone.at), 71) }
    : { line1: "нет известных зон", line2: "хвост прочитан, зон не видно" });

  ctx.cards.stats.set({
    line1: cutB("сессия " + hms(k.wallMs) + " · карт " + k.runs.length, 39),
    line2: cutB("в картах " + hms(k.mapMs) + " · средняя " +
                hms(k.runs.length ? k.mapMs / k.runs.length : 0), 71),
  });

  // «Итоги» — только божественные за сессию. Вторая строка нужна ровно тогда, когда
  // цифрам нельзя верить: сайт отказал, база ещё строится, вкладка не нашлась,
  // индекс отстаёт. В норме она пустая. Карточка живёт, пока сессия есть или
  // только что закончилась: показывать «+0 div» без сессии значило бы врать.
  if ((st.session || st.finished) && S && (S.snap || S.err || S.total >= 0)) {
    ctx.cards.loot.set({ line1: signed(e.div) + " div", line2: cutB(lootProblem(S, t, liveWatch(st)), 71) });
  }

  // Доход по времени: div/ч за сессию. Большое число прошивка рисует целым (int16),
  // дробный темп остаётся в статусе плагина. Точки — что нашли в каждом
  // десятиминутном окне, тоже пересчитанное в div/ч.
  ctx.cards.curve.set({ label: "за сессию",
                        number: Math.max(0, Math.round(e.div / hours)),
                        unit: "div/ч", windowSec: 90 * BUCKET_MS / 1000 });
  if (tick) emitCurve(ctx, st, S);
  return k;
}

// ---- подсказки настроек ---------------------------------------------------------

// Поле «Публичная вкладка»: имена публичных вкладок аккаунта — из того же поиска trade2, что
// и учёт (один поиск и до двух вычиток). Набирать имя по формату «~price N divine метка» больше
// не нужно — его можно выбрать (ревью 04.11.2026).
async function listTabs(ctx, values) {        // хост зовёт провайдер (ctx, значения формы)
  const acc = String((values && values.tradeAccount) || "").trim();
  if (!/^\S+#\d{4}$/.test(acc)) return [];
  const S = stashOf(ctx);
  const t = { account: acc, league: String((values && values.league) || "").trim() };
  const notes = {};
  const lg = await leagueOf(ctx, S, t, notes);
  if (!lg) return [];
  const q = await tradeReq(ctx, S.lim.search, TR + "/search/poe2/" + encodeURIComponent(lg), probeBody(acc), notes);
  if (!q || !Array.isArray(q.result) || !q.result.length) return [];
  const count = {};
  const ids = q.result.slice(0, 20);
  let i = 0;
  while (i < ids.length) {
    const d = await tradeReq(ctx, S.lim.fetch, TR + "/fetch/" + ids.slice(i, i + 10).join(",") +
                             "?query=" + encodeURIComponent(q.id), null, notes);
    if (!d) break;
    for (const it of d.result || []) {
      const name = it && it.listing && it.listing.stash && it.listing.stash.name;
      if (name) count[name] = (count[name] || 0) + 1;
    }
    i += 10;
  }
  return Object.keys(count).map(function (name) {
    const m = /~price\s+(\d+)\s+divine/i.exec(name);
    return { id: name, label: name, detail: m ? "лотов " + count[name] : "без цены divine в имени — не подойдёт" };
  });
}

// ---- плагин ------------------------------------------------------------------

definePlugin({
  providers: { listTabs },

  cards: {
    zone: { label: "Зона", type: "status" },
    stats: { label: "Итоги сессии", type: "status" },
    curve: { label: "Доход по времени", type: "spark" },
    loot: { label: "Итоги", type: "status" },
  },

  activate(ctx) {
    const logPoll = ctx.poll(async function () {
      const c = settings(ctx), t = tradeCfg(ctx);
      const st = loadState(ctx);
      scrubNames(st);              // битые имена из прошлых опросов не должны остаться на панели
      const notes = { rollback: false, sessionClosed: false, silence: false, quiet: false };

      const res = await readLog(ctx, st);
      if (res.err) {
        logBad = res.err;
        // Карточка говорит коротко (вторая строка ограничена 71 байтом), а статус —
        // целиком: с какой папкой плагин бился и что ответил агент.
        ctx.cards.zone.set({ line1: "нет доступа к логу", line2: res.short || "смотри статус" });
        return statusWith("папка: " + String(ctx.settings.get("logDir") || "не задана"));
      }
      logBad = res.mangled ? "лог пришёл не в UTF-8: имена зон не читаются" : "";
      feed(st, res.lines, c, notes);
      // Игра упала или закрыта крестиком: «Closing game gracefully» нет, а пауза сессии замечается
      // только по СЛЕДУЮЩЕЙ строке лога — без перезапуска игры сессия «шла» бы вечно, и находки во
      // вкладке приписывались бы ей. Лог молчит дольше паузы — сессия кончилась на последней строке.
      if (st.session && logIsLive(st) && Date.now() - st.lineTs > c.gapMs) closeSession(st, st.lineTs, notes);

      // Карточки рисуются и по состоянию лога, и по счётчикам вкладок: лог-опрос
      // читает «stash» только чтобы показать div и дорисовать точки графика.
      const S = stashOf(ctx);
      const k = render(ctx, st, c, S, true, t);
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
      if (!notes.quiet && notes.sessionClosed && st.finished) {
        const e = S.sessDiv[String(st.finished.start)] || { div: 0 };
        ctx.toast("done", "Сессия окончена",
                  k.runs.length + " карт · " + hms(k.mapMs) + " в картах · " + signed(e.div) + " div");
      }

      if (notes.rollback) return statusWith("время в логе откатилось — сессия начата заново");
      const cur = S.sessDiv[String(logSessOf(st))] || { div: 0 };
      const hours = Math.max(k.wallMs / 3600000, 0.25);
      // Потерять состояние молча — значит потом задвоить карты; об этом надо сказать.
      return statusWith((saved ? "" : "состояние не записано — кончилась память плагина · ") +
             "сессия " + hms(k.wallMs) + " · карт " + k.runs.length + " · " +
             signed(cur.div) + " div · темп " + fmtDiv(cur.div / hours) + " div/ч");
    }, { everySec: LOG_POLL_SEC });   // интервал зашит, см. комментарий у константы

    // Второй опрос — вкладки стеша: сеть тут дороже и медленнее, чем чтение хвоста
    // лога, и свои лимиты.
    const stashPoll = ctx.poll(async function () {
      const c = settings(ctx), t = tradeCfg(ctx);
      // Ответ этого опроса — часть общего статуса, а не его замена.
      const say = function (s) { stashNote = s; return statusWith(""); };
      const st = loadState(ctx);
      // let, не const: при нехватке памяти ниже S перечитывается из хранилища (ревью 04.11.2026 —
      // присваивание константе роняло опрос ровно в этой аварийной ветке)
      let S = stashOf(ctx);
      // «текущая» сессия нужна лишь для того, к какому блоку относить находки; сами
      // счётчики лежат в sessDiv по сессиям, поэтому обнулять при смене сессии нечего
      S.sess = logSessOf(st);
      if (!t.on) { ctx.storage.set("stash", S); return say("аккаунт не указан — вкладки не спрашиваем"); }
      // Фарма нет больше часа — вкладки раз в 10 минут, а не каждую минуту: бюджет поиска trade2
      // общий на IP (100 в час), его же тратит сайт торговли, которым человек пользуется сам.
      if (logIsLive(st) && !liveWatch(st) && S.sweepTs && Date.now() - S.sweepTs < IDLE_SWEEP_MS)
        return say("фарма нет — вкладки раз в " + IDLE_SWEEP_MS / 60000 + " мин");

      const notes = { gains: [], losses: [], err: null, wait: 0, capped: false, partial: false };
      S.sweepTs = Date.now();
      await sweepStash(ctx, S, t, notes);
      S.err = notes.err || "";             // карточка обязана говорить, почему цифры вчерашние
      // состояние лога перечитывается после сети: опрос лога мог закрыть забег или
      // открыть новый за то время, что мы ждали ответ сайта
      const st2 = loadState(ctx);
      S.sess = logSessOf(st2);
      const P = await refreshPrices(ctx, S.league, notes);
      S.priceErr = notes.priceErr || (P.at ? "" : "цены poe.ninja ещё не получены — в div только Divine");
      applyDeltas(S, notes, P);
      deflating(S);
      // напоминание о новой вкладке живёт, пока следующий полный снимок ничего нового
      // не увидит: тост можно и пропустить
      if (notes.tabNew) S.tabTxt = "новая вкладка «" + notes.tabName + "» — её содержимое не лут";
      else if (!notes.partial && !notes.err && !notes.capped) S.tabTxt = "";
      // Тост о находках — не на каждый свип (раз в минуту во время фарма это шум): копим и
      // говорим, когда набрался хотя бы 1 div или прошло 10 минут с первой находки (ревью 04.11.2026).
      // Копилка пишется вместе со снимком: иначе мелочь между свипами терялась.
      if (notes.gainItems) {
        const q0 = S.toastQ || (S.toastQ = { div: 0, items: 0, since: 0 });
        q0.div += notes.gainDiv; q0.items += notes.gainItems;
        if (!q0.since) q0.since = Date.now();
      }
      let saved = ctx.storage.set("stash", S);
      // Дельты уже применены к S, но в хосте лежит прежний снимок. Оставляем в памяти
      // ровно то, что сохранено: иначе следующий свип сравнит находки с неснятым
      // снимком и посчитает тот же лут второй раз.
      if (!saved) S = stashOf(ctx);
      render(ctx, st2, c, S, false, t);

      const q = S.toastQ;
      if (saved && q && q.items && (q.div >= 1 || Date.now() - q.since >= TOAST_EVERY_MS)) {
        ctx.toast("notice", "Находки в стеше", signed(Math.round(q.div * 100) / 100) + " div · " + q.items + " шт.");
        S.toastQ = { div: 0, items: 0, since: 0 };
        ctx.storage.set("stash", S);
      }
      if (notes.tabNew) {
        ctx.toast("notice", "Вкладка появилась",
                  "«" + notes.tabName + "» встала в поиск: " + notes.tabNew +
                  " поз. лутом не считаются");
      }
      if (!saved) return say("позиций не влезает в память плагина — разбей вкладку (до 100 слотов)");
      if (notes.err) return say(notes.err);
      if (notes.wait) return say("trade2 держит паузу ~" + Math.ceil(notes.wait / 1000) + " с — лимит запросов");
      const cur = S.sessDiv[String(S.sess || 0)] || { div: 0 };
      const bits = ["лига " + (S.league || "?"), "вкладка «" + t.tab + "»", "позиций " + S.mine,
                    "div " + fmtDiv(cur.div), "лаг " + S.lagMin + " мин"];
      if (P.at) bits.push("цены: " + Object.keys(P.div).length + " поз. (poe.ninja, " + hhmm(P.at) + ")");
      if (cur.unpriced) bits.push("без цены " + cur.unpriced + " поз. — в div не входят");
      if (S.priceErr) bits.push(S.priceErr);
      if (S.noTab) bits.push("среди лотов аккаунта её нет" +
                             (S.tabs ? "; видно: " + S.tabs : " (в этой цене у аккаунта " + S.total + " лотов)"));
      if (S.leagueGuess) bits.push("у аккаунта нет публичных лотов — проверь имя аккаунта или укажи лигу");
      if (S.nameless) bits.push("имена забыты у " + S.nameless + " старых позиций — div и позиции считаются");
      if (notes.capped) bits.push("добор id остановлен лимитом свипа");
      const big = bigFirst(S);
      if (big) bits.push("вкладка «" + big.t + "» не влезает в поиск (" + big.n +
                         " поз.) — разведи по разным числам цены, она не считается");
      if (S.tabTxt) bits.push(S.tabTxt);
      if (S.baseline) bits.push("база вкладок строится");
      return say(bits.join(" · "));
    }, { everySec: STASH_POLL_SEC });

    // Правка настройки должна быть видна сразу: без подписки на onChange хост
    // перезапускает плагин при сохранении формы (а сессия при этом теряется), а с
    // подпиской оба опроса стартуют по ручке .now() — интервалы-то зашиты.
    ctx.settings.onChange(function () { logPoll.now(); stashPoll.now(); });
  },
});

