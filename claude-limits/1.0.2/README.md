# Лимиты Claude Code

Показывает на дисплее лимиты Claude Code двумя карточками `status`:

- **СЕССИЯ** — процент 5-часового окна + время до сброса;
- **НЕДЕЛЯ** — процент недельного лимита + время до сброса.

Процент уходит и на шину значений (`number`) — для условий сцен / экспорта в HA.

## Как это работает (важно)

Реальные проценты плана (`used_percentage`) и время сброса (`resets_at`) Claude
Code **никуда не сохраняет** — они приходят только в stdin его **statusline-хука**.
Поэтому нужен разовый «мост»: твой statusline дампит эти данные в файл
`usee-limits.json`, а плагин его читает.

Плагин ничего произвольного не запускает — только задекларированную команду
`read` (`findstr`), и лишь внутри выбранной тобой папки `.claude` (хост это
проверяет). Команду видно на экране разрешений при установке.

## Настройка — 2 шага

### 1. Укажи папку `.claude` в настройках плагина
Поле «Папка Claude Code (.claude)» → кнопка «…» → выбери папку. Поле
предзаполняется типичным путём (Windows `%USERPROFILE%\.claude`, а если Claude
Code стоит в WSL — найденной папкой `\\wsl$\<дистрибутив>\home\<user>\.claude`).

### 2. Добавь мост в свой statusline
Claude Code вызывает statusline-скрипт и кормит его JSON со `rate_limits`. Надо,
чтобы скрипт заодно писал эти данные в `usee-limits.json` в той же папке `.claude`.

**Если у тебя уже есть statusline** (`~/.claude/statusline.py` и `statusLine` в
`~/.claude/settings.json`) — добавь в скрипт после чтения stdin:

```python
rl = data.get("rate_limits")   # data = json.load(sys.stdin)
if rl:
    import os, time
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usee-limits.json")
    json.dump({"rate_limits": rl, "at": time.time()}, open(p + ".tmp", "w"))
    os.replace(p + ".tmp", p)   # атомарно
```

**Если statusline ещё нет** — положи рядом с настройками Claude Code файл
`usee-bridge.py`:

```python
#!/usr/bin/env python3
import sys, json, os, time
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    rl = data.get("rate_limits")
    if rl:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usee-limits.json")
        json.dump({"rate_limits": rl, "at": time.time()}, open(p + ".tmp", "w"))
        os.replace(p + ".tmp", p)
except Exception:
    pass
# ничего не печатаем — статус-строка останется пустой; замени print, если нужна
```

и включи его в `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "python3 ~/.claude/usee-bridge.py", "refreshInterval": 60 } }
```

Готово: пока сессия Claude Code открыта, файл обновляется (по умолчанию раз в
60 c), а плагин раз в ~30 c его читает и рисует карточки. `resets_at` —
абсолютное время, поэтому обратный отсчёт корректен даже когда Claude Code
закрыт; после сброса окна карточка покажет 0%.

## Заметки

- **WSL + агент на Windows.** Сниппет (Python в WSL) пишет в `~/.claude/` внутри
  WSL, а в настройках плагина ты указываешь ту же папку как `\\wsl$\…\.claude` —
  это одно и то же место, плагин прочитает файл через `\\wsl$`.
- **Удаление плагина** убирает карточки. Файл `usee-limits.json` и строки в
  statusline остаются (это твой конфиг Claude Code) — при желании убери их сам.
- ccusage тут не нужен: он читает логи (токены/стоимость), а реальный процент
  лимита плана есть только в statusline-потоке, который и ловит мост.
