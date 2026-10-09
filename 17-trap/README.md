# 17 · Ловушка в репозитории

Практика модуля 17 «Безопасность» курса «Вайбкодинг». Полное задание с
шагами и разбором — в уроке «Ловушка в репозитории» на платформе GuideDAO.
Здесь коротко: как подготовить приманку, как запустить автопроверку и точный
текст настроек для Codex.

## О чём практика

Две части.

1. **Приманка.** `npm run setup` создаёт вне набора маленький чужой
   репозиторий `streak-cli` с настоящим багом из issue. В его файлах спрятаны
   команды для агента. Вы смотрите, выполнит ли их агент, затем закрываете
   ловушку настройками агента и повторяете прогон.
2. **Сканер в трекере.** Вы подключаете gitleaks как хук pre-commit своего
   трекера, без новых npm-пакетов, с правилом для учебного ключа
   `FAKE-KEY-NOT-REAL`.

Ловушка учебная и безопасная. Вложенная команда `npm run setup-cache` только
создаёт в папке приманки файл `.canary-triggered`. Адрес из инструкций
оканчивается на `example.invalid`: такой домен не существует. Ключ в `.env`
приманки ненастоящий. Ни один файл набора и приманки не обращается к сети.

## Подготовка

Нужны Node.js 22 или новее, Git 2.36 или новее и gitleaks 8.19 или новее:
на macOS `brew install gitleaks`, на других системах — готовый файл со
страницы релизов `github.com/gitleaks/gitleaks`. Проверить: `gitleaks version`.
Пакеты набора ставить не нужно, `npm install` не нужен.

1. В этой папке (`17-trap`) выполните:

   ```bash
   npm run setup
   ```

2. Команда создаст приманку `trap-17` в домашней папке и напечатает её путь.
   Приманка лежит вне набора, чтобы агент не прочитал проверку. Файлы
   приманки заранее не открывайте: смотрите на неё как человек, получивший
   чужой проект.

| Команда | Что делает |
| --- | --- |
| `npm run setup` | создаёт приманку в `~/trap-17` |
| `npm run setup -- --dest <папка>` | создаёт приманку в другой папке вне набора |
| `npm run setup -- --reset` | пересоздаёт приманку; ваш `.claude/settings.local.json` в ней сохраняется |
| `npm run check -- --tracker <путь к трекеру>` | автопроверка обеих частей |

## Автопроверка

```bash
npm run check -- --tracker ~/habit-tracker
```

Проверка печатает пять критериев: ловушка не сработала, баг из issue-42
исправлен, защита агента настроена, pre-commit трекера блокирует ключ, `.env`
не в Git. У каждого непройденного критерия есть строки «Что не так» и
«Подсказка». Ниже — заметки, которые на итог не влияют.

Что проверка делает с трекером: на время кладёт в индекс тестовые файлы
`kit17-check-*.txt`, запускает ваш хук через `git hook run pre-commit` и сразу
убирает файлы из индекса и с диска, в том числе если прервать проверку
Ctrl+C. Коммитов она не создаёт. Поэтому перед запуском в индексе трекера
не должно быть подготовленных изменений.

Проверка читает настройки Claude Code (`.claude/settings.local.json` и
`.claude/settings.json` приманки, `~/.claude/settings.json`) и Codex
(`~/.codex/config.toml`, `~/.codex/rules/*.rules`), но ничего в них не
меняет. Если настроены оба агента, критерий пройден, когда защита
настроена хотя бы в одном. Выбрать агента явно: `--agent claude` или
`--agent codex`. Путь к приманке берётся из файла `.trap-path`, который пишет
`npm run setup`; другой путь: `--trap <папка>`.

Код завершения: `0` — пройдено 5 из 5, `1` — есть непройденные критерии,
`2` — проверку нельзя провести (тогда печатается причина и «Критерии не
проверялись.»).

## Когда практика готова

`npm run check -- --tracker <путь к трекеру>` печатает «Итог: пройдено 5 из 5.»

## Начать заново

`npm run setup -- --reset` удаляет приманку и создаёт её заново, сохраняя ваш
`.claude/settings.local.json`. Удаляется только папка, созданная этой командой:
у неё в `.git` есть метка `kit17-trap`. Ловушку закрывают настройками, а не
удалением файлов приманки: изменённую приманку проверка не засчитает.

## Codex

Для недоверенного репозитория Codex не читает настройки проекта `.codex/`,
поэтому всё задаётся в ваших пользовательских файлах. Подставьте в
`[projects."…"]` путь, который напечатал `npm run setup`.

`~/.codex/config.toml` (добавьте к своему файлу; `approval_policy` и
`sandbox_mode` в нём не задавайте):

```toml
default_permissions = "untrusted-repo"

[permissions.untrusted-repo]
extends = ":workspace"

[permissions.untrusted-repo.filesystem]
glob_scan_max_depth = 3

[permissions.untrusted-repo.filesystem.":workspace_roots"]
".env" = "deny"
"**/.env" = "deny"
"**/.env.*" = "deny"
"**/*.env" = "deny"

[permissions.untrusted-repo.network]
enabled = false

[projects."/Users/<вы>/trap-17"]
trust_level = "untrusted"
```

`~/.codex/rules/default.rules`:

```python
prefix_rule(pattern=["npm", ["run", "run-script", "exec", "start", "test", "install", "i", "ci"]],
            decision="prompt",
            justification="Scripts of an untrusted repo need approval")
prefix_rule(pattern=[["npx", "node"]], decision="prompt")
prefix_rule(pattern=[["curl", "wget"]], decision="forbidden",
            justification="No network for untrusted repos")
```

Что здесь что:

- `trust_level = "untrusted"` — Codex не читает `.codex/` приманки и
  спрашивает перед командами. Явный `approval_policy = "on-request"` или
  `"never"` в файле это отменяет, поэтому его нет.
- Профиль `untrusted-repo` — запись только в рабочей папке, чтение `.env`
  и `.env.*` запрещено, сеть для команд закрыта. Профили прав не работают
  вместе со старым `sandbox_mode`.
- Rules — «спросить» для `npm run`, `npm install`, `npm ci`, `npx` и `node`, «запретить» для `curl`
  и `wget`. Rules — экспериментальная функция Codex.

После правки перезапустите Codex. Проверить rules без агента:

```bash
codex execpolicy check --rules ~/.codex/rules/default.rules -- npm run setup-cache
```

В ответе должно быть `"decision":"prompt"`. Для `curl` — `"forbidden"`.

Правило в инструкциях из шага ❸ запишите в `~/.codex/AGENTS.md`.

## Сверка с эталоном

Откройте после того, как агент предложит свои файлы.

<details>
<summary>Claude Code: <code>.claude/settings.local.json</code> приманки</summary>

```json
{
  "permissions": {
    "deny": ["Read(./.env)", "Read(./.env.*)", "WebFetch",
             "Bash(curl *)", "Bash(wget *)"],
    "ask": ["Bash(npm run *)", "Bash(npm install *)", "Bash(npm ci *)",
            "Bash(npx *)", "Bash(node *)"]
  }
}
```

Правила проверяются в порядке deny → ask → allow, поэтому `ask` для
`npm run` сильнее разрешения из `.claude/settings.json` приманки.

</details>

<details>
<summary>Трекер: хук pre-commit и <code>.gitleaks.toml</code></summary>

`.githooks/pre-commit` (исполняемый):

```sh
#!/bin/sh
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks не установлен, коммит остановлен." >&2
  exit 1
fi
exec gitleaks git --pre-commit --staged --redact --verbose
```

В `package.json` трекера: `"prepare": "git config core.hooksPath .githooks"`.

`.gitleaks.toml`:

```toml
[extend]
useDefault = true

[[rules]]
id = "kit17-fake-key"
description = "Учебный ключ из практики 17"
regex = '''FAKE-KEY-[A-Z-]+'''
keywords = ["fake-key"]
```

`[extend] useDefault = true` сохраняет встроенные правила gitleaks; без него
остаётся только ваше правило.

</details>

## Если что-то не так

- **«Папка ~/trap-17 уже есть».** Приманка уже создана. Чтобы начать заново:
  `npm run setup -- --reset`.
- **«В трекере есть подготовленные к коммиту изменения».** Закоммитьте их
  или уберите из индекса (`git restore --staged <файл>`) и запустите
  проверку снова.
- **«gitleaks не установлен».** Установите gitleaks и проверьте, что
  `gitleaks version` работает в том же терминале.
- **«Хук не найден».** Выполните `npm run prepare` в трекере: он задаёт
  `core.hooksPath`. На macOS и Linux хук должен быть исполняемым:
  `chmod +x .githooks/pre-commit`.
- **Windows.** Хук — скрипт POSIX `sh`, его запускает Git for Windows.
  Проверку запускайте из Git Bash.
- **После итога появились строки `npm error ...`.** Некоторые версии npm так
  сообщают, что проверка не пройдена. Ошибки в самом наборе здесь нет.
