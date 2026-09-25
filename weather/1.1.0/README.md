# Погода (weather)

Плагин Usee: текущая погода по городу через [Open-Meteo](https://open-meteo.com)
— бесплатный API **без ключа**. SDK 8.

## Карточки
- **gauge «температура»** — текущая t° как `number` со шкалой-заливкой
  (метрика −30…45 °C, имперская −20…115 °F).
- **status «условия»** — встроенная иконка погоды Usee (`sun`, `partly`, `cloud`,
  `fog`, `rain`, `snow`, `storm`) + описание (line1), «ощущается / влажность /
  ветер» (line2), t° в бейдже.

Плагин публикует обе карточки; **какие показывать и где** — раскладка сцен Usee,
**ширина** — настройки карточки Usee (как у встроенных).

## Настройки
| Ключ | Тип | Назначение |
|------|-----|-----------|
| `city` | string | Город — live-автокомплит на ввод (геокодинг Open-Meteo, провайдер `searchCity`); можно и вписать имя вручную |
| `units` | select | `metric` (°C · м/с, по умолчанию) или `imperial` (°F · mph) |
| `label` | string | Подпись карточек (по умолчанию — имя города) |
| `intervalMin` | number | Период опроса, 1–240 мин (по умолчанию 15); карточки живут 3 периода |

## Права
`net: ["*.open-meteo.com"]` — только геокодинг и прогноз Open-Meteo. Ключей и
секретов нет.

## Данные Open-Meteo
- Геокодинг: `https://geocoding-api.open-meteo.com/v1/search?name=<город>`
- Прогноз: `https://api.open-meteo.com/v1/forecast?...&current=temperature_2m,`
  `apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`

`weather_code` (WMO) переводится в русское описание и иконку внутри плагина.

## Локальная проверка
Агент → «Плагины» → **＋ «Плагин из папки разработки…»** → эта папка: без
копирования, правка файлов перезапускает плагин сам. Или положить `manifest.json`
и `plugin.js` в `%AppData%\PcMonitorAgent\plugins\weather\1.1.0\`. Без Windows:
`usee-plugin run plugins/weather --set city=Москва --png out/`.
