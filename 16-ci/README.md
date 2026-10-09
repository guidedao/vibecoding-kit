# 16 · PR с проверками

Практика модуля 16 «CI и релизы» курса «Вайбкодинг». Полное задание — в уроке
«PR с проверками» на платформе GuideDAO.

Нужны Node.js 22 или новее, Git и GitHub CLI 2.87 или новее (cli.github.com или
Homebrew). Войдите в него в своём терминале: `gh auth login --scopes workflow`.
Откройте эту папку (`16-ci`) в агенте и попросите выполнить `npm run setup`.
Появится папка `tracker` с ветками `main` и `counter-refactor`. Начните новую
сессию агента в `16-ci/tracker`, заполните `.env.local` по `.env.example`,
выполните `npm install` и `npx playwright install chromium`. Автопроверка —
`npm run check` в папке `tracker`.

Начать заново: удалите папку `tracker` и снова выполните `npm run setup`.
