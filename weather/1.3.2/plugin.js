// @ts-check
/// <reference path="../../usee-plugin-template/sdk/usee-plugin.d.ts" />
// Погода для Usee (SDK 11) — текущая погода и прогноз Open-Meteo (бесплатно, без ключа).
// Карточки: «температура» (gauge), «условия» (status) и «прогноз» (status).
//
// 1.3.0 (SDK 11):
// - Город или точные координаты ("lat, lon") у каждого экземпляра.
// - Полноценная поддержка дня и ночи (иконка star для ясной ночи).
// - Расширенные данные: атмосферное давление (мм рт. ст. / гПа / inHg), направление ветра,
//   прогноз min/max на день и осадки.
// - Карточка суточного прогноза (forecast).
// - Кэширование геокодинга в постоянном хранилище (storage).
// - Публикация сущностей в шину значений (ctx.entities).

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_HOSTS = ["api.open-meteo.com", "historical-forecast-api.open-meteo.com"];
const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Код погоды WMO → [описание, встроенная иконка Usee, короткая форма].
// Короткая — для названий длиннее 39 байт строки прибора ("ПЕРЕМЕННАЯ ОБЛАЧНОСТЬ" = 41 байт).
const WMO = {
  0: ["Ясно", "sun"],
  1: ["Преимущественно ясно", "partly"],
  2: ["Переменная облачность", "partly", "Перем. облачность"],
  3: ["Пасмурно", "cloud"],
  45: ["Туман", "fog"],
  48: ["Изморозь", "fog"],
  51: ["Слабая морось", "rain"],
  53: ["Морось", "rain"],
  55: ["Сильная морось", "rain"],
  56: ["Ледяная морось", "rain"],
  57: ["Сильная ледяная морось", "rain", "Ледяная морось"],
  61: ["Небольшой дождь", "rain"],
  63: ["Дождь", "rain"],
  65: ["Сильный дождь", "rain"],
  66: ["Ледяной дождь", "rain"],
  67: ["Сильный ледяной дождь", "rain", "Ледяной дождь"],
  71: ["Небольшой снег", "snow"],
  73: ["Снег", "snow"],
  75: ["Сильный снег", "snow"],
  77: ["Снежные зёрна", "snow"],
  80: ["Небольшой ливень", "rain"],
  81: ["Ливень", "rain"],
  82: ["Сильный ливень", "rain"],
  85: ["Небольшой снегопад", "snow"],
  86: ["Снегопад", "snow"],
  95: ["Гроза", "storm"],
  96: ["Гроза с градом", "storm"],
  99: ["Сильная гроза с градом", "storm", "Гроза с градом"],
};

const WIND_DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];

function windDir(deg) {
  if (typeof deg !== "number") return "";
  return WIND_DIRS[Math.round(deg / 45) % 8];
}

function parseCoords(str) {
  const m = String(str || "").match(COORD_RE);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    latitude: lat,
    longitude: lon,
  };
}

function formatTemp(t) {
  if (typeof t !== "number") return "—";
  return Math.round(t) + "°";
}

function formatPressure(hpa, unit) {
  if (typeof hpa !== "number") return { val: null, text: "" };
  if (unit === "hpa") {
    const val = Math.round(hpa);
    return { val, text: `${val} гПа` };
  }
  if (unit === "inhg") {
    const val = Number((hpa * 0.02953).toFixed(2));
    return { val, text: `${val} inHg` };
  }
  const val = Math.round(hpa * 0.750062);
  return { val, text: `${val} мм` };
}

async function geocode(name) {
  const r = await fetch(`${GEO}?name=${encodeURIComponent(name)}&count=6&language=ru&format=json`);
  if (!r.ok) throw new Error("геокодинг: HTTP " + r.status);
  const data = await r.json();
  return data?.results ?? [];
}

async function resolvePlace(ctx, rawCity) {
  const city = String(rawCity || "").trim();
  if (!city) throw new Error("не указан город");

  const coords = parseCoords(city);
  if (coords) return coords;

  const key = "geo:" + city.toLowerCase();
  const cached = ctx.storage.get(key);
  if (cached && typeof cached === "object" && typeof cached.latitude === "number") {
    return cached;
  }

  const results = await geocode(city);
  if (!results.length) throw new Error("город не найден: " + city);
  const p = results[0];
  const place = {
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    admin1: p.admin1,
    country: p.country,
  };
  ctx.storage.set(key, place);
  return place;
}

async function forecast(ctx, query) {
  const known = ctx.storage.get("forecastHost");
  const first = FORECAST_HOSTS.includes(known) ? known : FORECAST_HOSTS[0];
  const order = [first, ...FORECAST_HOSTS.filter(h => h !== first)];
  const errors = [];
  for (const host of order) {
    try {
      const r = await fetch(`https://${host}/v1/forecast?${query}`);
      if (!r.ok) {
        let reason = "";
        try {
          const j = await r.json();
          if (j?.reason) reason = `: ${j.reason}`;
        } catch (_) {}
        throw new Error(`${host}: HTTP ${r.status}${reason}`);
      }
      if (host !== known) ctx.storage.set("forecastHost", host);
      return await r.json();
    } catch (e) {
      errors.push(String(e?.message ?? e));
    }
  }
  throw new Error(errors.join(" · "));
}

definePlugin({
  cards: {
    temp: {
      label: "Погода · температура",
      type: "gauge",
      fields: { number: { label: "Температура", kind: "number" } },
    },
    cond: {
      label: "Погода · условия",
      type: "status",
      fields: {
        state: { label: "Погода", kind: "string" },
        number: { label: "Ощущается", kind: "number" },
      },
    },
    forecast: {
      label: "Погода · прогноз",
      type: "status",
      fields: {
        state: { label: "Прогноз", kind: "string" },
        number: { label: "Максимум", kind: "number" },
      },
    },
  },

  providers: {
    async searchCity(ctx, form) {
      const q = String(form?.city ?? "").trim();
      if (q.length < 2) return [];

      const coords = parseCoords(q);
      if (coords) {
        return [{
          id: `${coords.latitude}, ${coords.longitude}`,
          label: `Координаты: ${coords.latitude}, ${coords.longitude}`,
          detail: `${coords.latitude.toFixed(2)},${coords.longitude.toFixed(2)}`,
        }];
      }

      let results;
      try {
        results = await geocode(q);
      } catch (e) {
        ctx.log.warn(`геокодинг «${q}»: ${e?.message ?? e}`);
        return [];
      }

      return results.map(p => ({
        id: p.name,
        label: [p.name, p.admin1, p.country].filter(Boolean).join(", "),
        detail: `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`,
      }));
    },
  },

  activate(ctx) {
    const metric = ctx.settings.get("units") !== "imperial";
    const deg = metric ? "°C" : "°F";
    const pressureUnit = String(ctx.settings.get("pressureUnit") ?? "mmhg");
    const pressUnitLabel = pressureUnit === "hpa" ? "гПа" : (pressureUnit === "inhg" ? "inHg" : "мм рт. ст.");

    // Объявляем сущности в шине значений
    const entitiesList = [];
    ctx.instances.each(inst => {
      const prefix = inst.id && inst.id !== "1" ? `${inst.id}.` : "";
      const nameSuffix = inst.name ? ` (${inst.name})` : "";
      entitiesList.push(
        { id: `${prefix}temperature`, label: `Температура${nameSuffix}`, kind: "number", unit: deg },
        { id: `${prefix}apparent_temperature`, label: `Ощущается${nameSuffix}`, kind: "number", unit: deg },
        { id: `${prefix}temp_max`, label: `Макс. температура${nameSuffix}`, kind: "number", unit: deg },
        { id: `${prefix}temp_min`, label: `Мин. температура${nameSuffix}`, kind: "number", unit: deg },
        { id: `${prefix}humidity`, label: `Влажность${nameSuffix}`, kind: "number", unit: "%" },
        { id: `${prefix}pressure`, label: `Давление${nameSuffix}`, kind: "number", unit: pressUnitLabel },
        { id: `${prefix}wind_speed`, label: `Скорость ветра${nameSuffix}`, kind: "number", unit: metric ? "м/с" : "mph" },
        { id: `${prefix}wind_dir`, label: `Направление ветра${nameSuffix}`, kind: "string" },
        { id: `${prefix}condition`, label: `Условия${nameSuffix}`, kind: "string" },
        { id: `${prefix}is_day`, label: `День${nameSuffix}`, kind: "bool" }
      );
    });
    ctx.entities.declare(entitiesList);

    ctx.instances.each(inst => {
      let currentCity = "";
      let place = null;

      inst.poll(async () => {
        const city = String(inst.settings.get("city") ?? "").trim();
        if (city !== currentCity) {
          place = null;
          currentCity = city;
        }
        if (!place) place = await resolvePlace(ctx, city);

        const query = `latitude=${place.latitude}&longitude=${place.longitude}` +
          "&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m" +
          "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum" +
          "&timezone=auto&forecast_days=2" +
          (metric ? "&wind_speed_unit=ms" : "&temperature_unit=fahrenheit&wind_speed_unit=mph");

        const resp = await forecast(ctx, query);
        const now = resp?.current;
        if (typeof now?.temperature_2m !== "number") throw new Error("нет данных о погоде");

        const daily = resp?.daily;
        const t = Math.round(now.temperature_2m);
        const isDay = typeof now.is_day === "number" ? now.is_day : 1;
        const [text, baseIcon, short] = WMO[now.weather_code] ?? ["Погода", "cloud"];
        const icon = (isDay === 0 && (now.weather_code === 0 || now.weather_code === 1)) ? "star" : baseIcon;

        const wDir = windDir(now.wind_direction_10m);
        const wSpeed = typeof now.wind_speed_10m === "number"
          ? Math.round(now.wind_speed_10m) + (metric ? " м/с" : " mph")
          : "";
        const windFull = [wDir, wSpeed].filter(Boolean).join(" ");

        const press = formatPressure(now.pressure_msl, pressureUnit);
        const feels = typeof now.apparent_temperature === "number"
          ? `ощущается ${formatTemp(now.apparent_temperature)}`
          : "";
        const hum = typeof now.relative_humidity_2m === "number"
          ? `${Math.round(now.relative_humidity_2m)}%`
          : "";

        const hasDaily = Array.isArray(daily?.temperature_2m_max) && daily.temperature_2m_max.length > 0;
        const tMaxToday = hasDaily ? daily.temperature_2m_max[0] : null;
        const tMinToday = hasDaily && Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min[0] : null;

        const todayRange = (tMaxToday != null && tMinToday != null)
          ? `днём ${formatTemp(tMaxToday)} · ночью ${formatTemp(tMinToday)}`
          : (tMaxToday != null ? `днём ${formatTemp(tMaxToday)}` : "");

        // 1. Карточка «Температура» (gauge)
        inst.cards.temp.set({
          label: [place.name.toUpperCase(), "ПОГОДА"],
          number: now.temperature_2m,
          state: String(t),
          unit: deg,
          min: metric ? -30 : -20,
          max: metric ? 45 : 115,
        });

        // 2. Карточка «Условия» (status)
        const line2Variants = [
          [todayRange, feels, hum, press.text, windFull].filter(Boolean).join(" · "),
          [feels, hum, press.text, windFull].filter(Boolean).join(" · "),
          [feels, hum, windFull].filter(Boolean).join(" · "),
          [feels, wSpeed].filter(Boolean).join(" · "),
          wSpeed,
        ].filter(v => v.length > 0);

        inst.cards.cond.set({
          icon,
          line1: short ? [text.toUpperCase(), short.toUpperCase()] : text.toUpperCase(),
          state: text,
          number: typeof now.apparent_temperature === "number" ? now.apparent_temperature : now.temperature_2m,
          line2: line2Variants.length > 0 ? line2Variants : undefined,
          badge: t + "°",
          badgeKind: "accent",
        });

        // 3. Карточка «Прогноз» (status)
        if (hasDaily && tMaxToday != null) {
          const dCode = daily?.weather_code?.[0] ?? now.weather_code;
          const [dText, dIcon, dShort] = WMO[dCode] ?? ["Погода", "cloud"];
          const precip = daily?.precipitation_sum?.[0] ?? 0;
          const precipStr = precip > 0 ? ` · осадки ${precip} мм` : "";

          const fVariants = [
            `ночью ${formatTemp(tMinToday)} · днём ${formatTemp(tMaxToday)}${precipStr}`,
            `${formatTemp(tMinToday)}…${formatTemp(tMaxToday)}${precipStr}`,
            `${formatTemp(tMinToday)}…${formatTemp(tMaxToday)}`,
          ];

          const fLine1 = [
            ("СЕГОДНЯ: " + dText).toUpperCase(),
            dShort ? ("СЕГОДНЯ: " + dShort).toUpperCase() : "",
            dText.toUpperCase(),
            dShort ? dShort.toUpperCase() : "",
          ].filter(Boolean);

          inst.cards.forecast.set({
            icon: dIcon,
            line1: fLine1,
            state: dText,
            number: tMaxToday,
            line2: fVariants,
            badge: formatTemp(tMaxToday),
            badgeKind: "plain",
          });
        } else {
          inst.cards.forecast.remove();
        }

        // 4. Публикация в шину значений
        const prefix = inst.id && inst.id !== "1" ? `${inst.id}.` : "";
        ctx.entities.setMany({
          [`${prefix}temperature`]: now.temperature_2m,
          [`${prefix}apparent_temperature`]: now.apparent_temperature ?? null,
          [`${prefix}humidity`]: now.relative_humidity_2m ?? null,
          [`${prefix}pressure`]: press.val,
          [`${prefix}wind_speed`]: now.wind_speed_10m ?? null,
          [`${prefix}wind_dir`]: wDir || null,
          [`${prefix}condition`]: text,
          [`${prefix}is_day`]: isDay === 1,
          [`${prefix}temp_max`]: tMaxToday,
          [`${prefix}temp_min`]: tMinToday,
        });

        return `${place.name} · ${t}${deg}`;
      }, { everySec: Math.max(60, 60 * (Number(ctx.settings.get("intervalMin")) || 15)) });
    });
  },
});
