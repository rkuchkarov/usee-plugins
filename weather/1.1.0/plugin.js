// Погода для Usee — текущая погода Open-Meteo (бесплатно, без ключа): карточка
// «температура» (gauge) и «условия» (status с иконкой погоды). Какие из них
// показывать и где, решает человек в раскладке сцен — плагин публикует обе.

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

// Код погоды WMO → [описание, встроенная иконка Usee].
const WMO = {
  0: ["Ясно", "sun"],
  1: ["Преимущественно ясно", "partly"], 2: ["Переменная облачность", "partly"], 3: ["Пасмурно", "cloud"],
  45: ["Туман", "fog"], 48: ["Изморозь", "fog"],
  51: ["Слабая морось", "rain"], 53: ["Морось", "rain"], 55: ["Сильная морось", "rain"],
  56: ["Ледяная морось", "rain"], 57: ["Сильная ледяная морось", "rain"],
  61: ["Небольшой дождь", "rain"], 63: ["Дождь", "rain"], 65: ["Сильный дождь", "rain"],
  66: ["Ледяной дождь", "rain"], 67: ["Сильный ледяной дождь", "rain"],
  71: ["Небольшой снег", "snow"], 73: ["Снег", "snow"], 75: ["Сильный снег", "snow"], 77: ["Снежные зёрна", "snow"],
  80: ["Небольшой ливень", "rain"], 81: ["Ливень", "rain"], 82: ["Сильный ливень", "rain"],
  85: ["Небольшой снегопад", "snow"], 86: ["Снегопад", "snow"],
  95: ["Гроза", "storm"], 96: ["Гроза с градом", "storm"], 99: ["Сильная гроза с градом", "storm"],
};

async function geocode(name) {
  const r = await fetch(`${GEO}?name=${encodeURIComponent(name)}&count=6&language=ru&format=json`);
  if (!r.ok) throw new Error("геокодинг: HTTP " + r.status);
  return (await r.json()).results ?? [];
}

definePlugin({
  cards: {
    temp: { label: "Погода · температура", type: "gauge" },
    cond: { label: "Погода · условия", type: "status" },
  },

  // Автокомплит поля «Город»: хост зовёт на ввод, со значениями формы.
  providers: {
    async searchCity(ctx, form) {
      const q = String(form.city ?? "").trim();
      if (q.length < 2) return [];
      return (await geocode(q)).map(p => ({
        id: p.name,
        label: [p.name, p.admin1, p.country].filter(Boolean).join(", "),
        detail: `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`,
      }));
    },
  },

  activate(ctx) {
    const city = String(ctx.settings.get("city") ?? "").trim();
    if (!city) { ctx.status.set("warn", "укажите город"); return; }
    const metric = ctx.settings.get("units") !== "imperial";
    const deg = metric ? "°C" : "°F";
    let place = null;

    ctx.poll(async () => {
      if (!place) place = (await geocode(city))[0];
      if (!place) throw new Error("город не найден: " + city);

      const r = await fetch(`${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&timezone=auto" + (metric ? "" : "&temperature_unit=fahrenheit&wind_speed_unit=mph"));
      if (!r.ok) throw new Error("прогноз: HTTP " + r.status);
      const now = (await r.json()).current;
      if (typeof now?.temperature_2m !== "number") throw new Error("нет данных о погоде");

      const t = Math.round(now.temperature_2m);
      const [text, icon] = WMO[now.weather_code] ?? ["Погода", "cloud"];
      ctx.cards.temp.set({
        label: String(ctx.settings.get("label") || place.name).toUpperCase(),
        number: now.temperature_2m, state: String(t), unit: deg,
        min: metric ? -30 : -20, max: metric ? 45 : 115,
      });
      ctx.cards.cond.set({
        icon, line1: text.toUpperCase(), state: text,
        line2: [`ощущается ${Math.round(now.apparent_temperature)}°`, `${Math.round(now.relative_humidity_2m)}%`,
                Math.round(now.wind_speed_10m) + (metric ? " м/с" : " mph")].join(" · "),
        badge: t + "°", badgeKind: "accent",
      });
      return `${place.name} · ${t}${deg}`;
    }, { everySec: 60 * ctx.settings.get("intervalMin") });
  },
});
