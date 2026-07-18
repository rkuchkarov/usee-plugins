// Погода для Usee — карточки текущей погоды через Open-Meteo (бесплатно, без
// API-ключа). Геокодинг города → текущие данные (температура, ощущается,
// влажность, ветер, код погоды) → карточки:
//   · gauge  «температура» — number = t°, шкала-заливка от min до max;
//   · status «условия»     — line1 = описание, line2 = ощущается/влажность/ветер,
//                             бейдж = t°.
// Что рисовать (обе / только gauge / только status) выбирается настройкой «Карточки».
// Значение несут RESERVED-поля (state всегда, number когда честно числовое) —
// см. типизированный контракт SDK.

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const DASH = "—";

// Период опроса по умолчанию и множитель staleness (карточка уходит с панели,
// если не обновлялась дольше — держим с большим запасом относительно периода).
const DEFAULT_INTERVAL_MIN = 15;

// Коды погоды WMO → человекочитаемое описание (RU). Open-Meteo отдаёт weather_code.
function wmoText(code) {
  const m = {
    0: "Ясно",
    1: "Преимущественно ясно", 2: "Переменная облачность", 3: "Пасмурно",
    45: "Туман", 48: "Изморозь",
    51: "Слабая морось", 53: "Морось", 55: "Сильная морось",
    56: "Ледяная морось", 57: "Сильная ледяная морось",
    61: "Небольшой дождь", 63: "Дождь", 65: "Сильный дождь",
    66: "Ледяной дождь", 67: "Сильный ледяной дождь",
    71: "Небольшой снег", 73: "Снег", 75: "Сильный снег",
    77: "Снежные зёрна",
    80: "Небольшой ливень", 81: "Ливень", 82: "Сильный ливень",
    85: "Небольшой снегопад", 86: "Снегопад",
    95: "Гроза", 96: "Гроза с градом", 99: "Сильная гроза с градом",
  };
  return code == null ? DASH : (m[code] || "Погода");
}

function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function isMetric(ctx) { return String(ctx.settings.get("units") || "metric") !== "imperial"; }

// ---- процедурные иконки погоды (RGB565, без сети/ассетов) --------------------
// Рисуем простые глифы в квадрат ICON×ICON и кодируем в «WxH,base64(RGB565 LE)»
// для ctx.cards.icon. Фон = цвет плитки устройства (UI_TILE #23272E) → глиф
// сидит бесшовно, как у обычной иконочной плитки. Иконка идёт на status-карточку.
const ICON = 24;

function rgb565(r, g, b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }

const C_BG   = rgb565(0x23, 0x27, 0x2E);   // плитка (UI_TILE)
const C_SUN  = rgb565(0xFF, 0xC8, 0x33);
const C_CLD  = rgb565(0xC8, 0xCE, 0xD8);
const C_CLDD = rgb565(0x88, 0x90, 0xA0);   // тёмное облако (гроза)
const C_RAIN = rgb565(0x4F, 0xA8, 0xFF);
const C_SNOW = rgb565(0xF0, 0xF4, 0xFA);
const C_BOLT = rgb565(0xFF, 0xD1, 0x33);
const C_FOG  = rgb565(0x9A, 0xA2, 0xB0);

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length, has2 = i + 2 < bytes.length;
    const b0 = bytes[i] & 0xFF, b1 = has1 ? bytes[i + 1] & 0xFF : 0, b2 = has2 ? bytes[i + 2] & 0xFF : 0;
    out += B64_ALPHABET[b0 >> 2] + B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)] +
           (has1 ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
           (has2 ? B64_ALPHABET[b2 & 63] : "=");
  }
  return out;
}

function newCanvas() { const px = new Array(ICON * ICON); for (let i = 0; i < px.length; i++) px[i] = C_BG; return px; }
function setPx(px, x, y, c) { if (x >= 0 && x < ICON && y >= 0 && y < ICON) px[y * ICON + x] = c; }
function disc(px, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) setPx(px, cx + x, cy + y, c);
}
function rect(px, x0, y0, w, h, c) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPx(px, x0 + x, y0 + y, c); }

function drawSun(px, cx, cy, r, col) {
  disc(px, cx, cy, r, col);
  for (let a = 0; a < 8; a++) {                       // 8 лучей по 2px
    const c = Math.cos(a * Math.PI / 4), s = Math.sin(a * Math.PI / 4);
    setPx(px, cx + Math.round(c * (r + 2)), cy + Math.round(s * (r + 2)), col);
    setPx(px, cx + Math.round(c * (r + 3)), cy + Math.round(s * (r + 3)), col);
  }
}
function drawCloud(px, cx, cy, col) {
  disc(px, cx - 5, cy + 1, 5, col);
  disc(px, cx + 5, cy + 1, 5, col);
  disc(px, cx, cy - 3, 6, col);
  rect(px, cx - 9, cy - 1, 19, 6, col);
}

function encodeIcon(px) {
  const bytes = new Array(px.length * 2);
  for (let i = 0; i < px.length; i++) { const v = px[i]; bytes[i * 2] = v & 0xFF; bytes[i * 2 + 1] = (v >> 8) & 0xFF; }
  return ICON + "x" + ICON + "," + b64(bytes);
}

const ICON_IDS = ["sun", "partly", "cloud", "fog", "rain", "snow", "storm"];   // ≤8 на плагин
const DROP_X = [7, 12, 17];
const BOLT_PX = [[12, 15], [11, 17], [13, 17], [11, 19], [12, 19], [10, 21]];

function buildIcon(id) {
  const px = newCanvas();
  if (id === "sun") {
    drawSun(px, 12, 12, 6, C_SUN);
  } else if (id === "partly") {
    drawSun(px, 8, 8, 4, C_SUN); drawCloud(px, 14, 15, C_CLD);
  } else if (id === "cloud") {
    drawCloud(px, 12, 11, C_CLD);
  } else if (id === "fog") {
    for (let k = 0; k < 4; k++) rect(px, 4, 7 + k * 4, 16, 2, C_FOG);
  } else if (id === "rain") {
    drawCloud(px, 12, 9, C_CLD);
    for (let k = 0; k < DROP_X.length; k++) rect(px, DROP_X[k], 17, 2, 4, C_RAIN);
  } else if (id === "snow") {
    drawCloud(px, 12, 9, C_CLD);
    for (let k = 0; k < DROP_X.length; k++) disc(px, DROP_X[k], 18, 1, C_SNOW);
  } else if (id === "storm") {
    drawCloud(px, 12, 9, C_CLDD);
    for (let k = 0; k < BOLT_PX.length; k++) setPx(px, BOLT_PX[k][0], BOLT_PX[k][1], C_BOLT);
  }
  return encodeIcon(px);
}

// Код погоды WMO → id иконки.
function iconIdFor(code) {
  if (code == null) return "cloud";
  if (code === 0) return "sun";
  if (code === 1 || code === 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "rain";                                       // 51–67, 80–82: морось/дождь/ливни
}

// Геокодинг: имя города → массив кандидатов {name, latitude, longitude, admin1, country}.
function geocode(ctx, name) {
  const url = GEO + "?name=" + encodeURIComponent(name) + "&count=6&language=ru&format=json";
  return ctx.net.fetch(url).then(r => {
    if (!r.ok) throw "геокодинг: HTTP " + r.status;
    const j = r.json();
    return (j && Array.isArray(j.results)) ? j.results : [];
  });
}

function placeLabel(r) {
  return [r.name, r.admin1, r.country].filter(Boolean).join(", ");
}

definePlugin({
  // Живой автокомплит поля «Город»: хост зовёт searchCity на ввод, передавая
  // текущие значения формы (form.city = набранный текст). Геокодим и отдаём
  // кандидатов; id = имя города (оно и попадёт в поле при выборе).
  providers: {
    searchCity(ctx, form) {
      const q = String((form && form.city) || ctx.settings.get("city") || "").trim();
      if (q.length < 2) return [];
      return geocode(ctx, q).then(rs => rs.filter(r => r && r.name).map(r => ({
        id: String(r.name),
        label: placeLabel(r),
        detail: num(r.latitude) != null && num(r.longitude) != null
          ? r.latitude.toFixed(2) + "," + r.longitude.toFixed(2) : undefined,
      })));
    },
  },

  activate(ctx) {
    let geo = null;        // {lat, lon, name} — разрешённые координаты города
    let geoKey = "";       // строка города, для которой geo актуален (кэш)
    let pollTimer = -1;

    const cardMode   = () => String(ctx.settings.get("card") || "both");
    const tUnit      = () => isMetric(ctx) ? "°C" : "°F";
    const windUnit   = () => isMetric(ctx) ? " м/с" : " mph";
    const labelText  = () => String(ctx.settings.get("label") ||
                                    (geo && geo.name) || ctx.settings.get("city") || "Погода").toUpperCase();

    function intervalMs() {
      const m = num(ctx.settings.get("intervalMin"));
      return (m != null && m >= 1 && m <= 240 ? m : DEFAULT_INTERVAL_MIN) * 60000;
    }
    function stalenessSec() {
      return Math.max(Math.round(intervalMs() / 1000) * 2, 1800);   // ≥ 30 мин запаса
    }

    // Ширина карточек (общая для обеих) — как в остальных плагинах Usee.
    function widthOpts(o) {
      const w = ctx.settings.get("width");
      if (w === "fixed" || w === "flex") {
        o.width = w;
        const mn = num(ctx.settings.get("minW")); if (mn != null) o.minW = Math.min(6, Math.max(2, mn | 0));
        const mx = num(ctx.settings.get("maxW")); if (mx != null) o.maxW = Math.min(6, Math.max(2, mx | 0));
      }
      return o;
    }

    // Каталог карточек — чтобы они были в раскладке/пинах даже без данных.
    function declare() {
      const mode = cardMode();
      const list = [];
      if (mode !== "status") list.push({ id: "temp", label: "Погода · температура", type: "gauge" });
      if (mode !== "gauge")  list.push({ id: "cond", label: "Погода · условия", type: "status" });
      ctx.cards.declare(list);
    }

    function render(cur) {
      const mode = cardMode();
      const metric = isMetric(ctx);
      const stale = stalenessSec();

      // gauge «температура»
      if (mode !== "status") {
        const t = cur.temp;
        const p = { type: "gauge", label: labelText(), state: t == null ? DASH : String(Math.round(t)), unit: tUnit() };
        if (t != null) {
          p.number = t;                                   // gauge рисует number
          if (metric) { p.min = -30; p.max = 45; } else { p.min = -20; p.max = 115; }
        }
        ctx.cards.upsert("temp", p, widthOpts({ band: 4, order: 1, stalenessSec: stale }));
      } else {
        ctx.cards.remove("temp");
      }

      // status «условия»
      if (mode !== "gauge") {
        const parts = [];
        if (cur.feels != null)    parts.push("ощущается " + Math.round(cur.feels) + "°");
        if (cur.humidity != null) parts.push(Math.round(cur.humidity) + "%");
        if (cur.wind != null)     parts.push(Math.round(cur.wind) + windUnit());
        const p = {
          type: "status",
          icon: "wx-" + iconIdFor(cur.code),
          line1: cur.text.toUpperCase(),
          state: cur.text,
          badge: cur.temp == null ? DASH : (Math.round(cur.temp) + "°"),
          badgeKind: "accent",
        };
        if (parts.length) p.line2 = parts.join(" · ");
        ctx.cards.upsert("cond", p, widthOpts({ band: 4, order: 2, stalenessSec: stale }));
      } else {
        ctx.cards.remove("cond");
      }
    }

    function fetchForecast() {
      const u = FORECAST +
        "?latitude=" + geo.lat + "&longitude=" + geo.lon +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&timezone=auto" +
        (isMetric(ctx) ? "" : "&temperature_unit=fahrenheit&wind_speed_unit=mph");
      return ctx.net.fetch(u).then(r => {
        if (!r.ok) throw "прогноз: HTTP " + r.status;
        const j = r.json();
        const c = j && j.current;
        if (!c) throw "нет данных о погоде";
        const code = num(c.weather_code);
        return {
          temp: num(c.temperature_2m),
          feels: num(c.apparent_temperature),
          humidity: num(c.relative_humidity_2m),
          wind: num(c.wind_speed_10m),
          code,
          text: wmoText(code),
        };
      });
    }

    function refresh() {
      const city = String(ctx.settings.get("city") || "").trim();
      if (!city) { ctx.status.set("warn", "укажите город"); return; }

      const needGeo = !geo || geoKey !== city;
      const geoStep = needGeo
        ? geocode(ctx, city).then(rs => {
            if (!rs.length) throw "город не найден: " + city;
            geo = { lat: rs[0].latitude, lon: rs[0].longitude, name: rs[0].name };
            geoKey = city;
          })
        : Promise.resolve();

      geoStep
        .then(fetchForecast)
        .then(cur => {
          render(cur);
          ctx.status.set("ok", geo.name + " · " +
            (cur.temp == null ? DASH : Math.round(cur.temp) + tUnit()));
        })
        .catch(e => { ctx.log.warn("погода: " + e); ctx.status.set("error", String(e)); });
    }

    function reschedule() {
      if (pollTimer !== -1) ctx.timers.clear(pollTimer);
      pollTimer = ctx.timers.setInterval(refresh, intervalMs());
    }

    // Иконки погоды статичны — регистрируем один раз (≤8 на плагин).
    for (let k = 0; k < ICON_IDS.length; k++) ctx.cards.icon("wx-" + ICON_IDS[k], buildIcon(ICON_IDS[k]));

    declare();
    refresh();
    reschedule();

    // Смена настроек → сбросить кэш координат, перевыпустить каталог и опросить.
    ctx.settings.onChange(() => {
      geo = null; geoKey = "";
      declare();
      refresh();
      reschedule();
    });
  },

  deactivate() {
    // таймеры и карточки хост закрывает/убирает сам при выключении плагина
  },
});
