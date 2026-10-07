// Автопроверка практики «Слияние двух веток».
// Запуск: npm run check в папке 07-merge-conflict/tracker.
// Проверка только читает репозиторий и запускает тесты, ничего не меняет.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheck, git, runNodeTests } from './kit-check.mjs';

const PRACTICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACKER = path.join(PRACTICE, 'tracker');
const STATE_FILE = path.join(PRACTICE, '.kit/state.json');

if (!existsSync(STATE_FILE) || !existsSync(path.join(TRACKER, '.git'))) {
  console.log('Сначала выполните npm run setup в папке 07-merge-conflict');
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const g = (...args) => git(TRACKER, args);
const isAncestor = (a, b) => g('merge-base', '--is-ancestor', a, b).ok;
const gitPathExists = (name) => {
  const rel = g('rev-parse', '--git-path', name);
  return rel.ok && existsSync(path.resolve(TRACKER, rel.out));
};
const blob = (rev, file) => {
  const r = g('rev-parse', '--verify', '--quiet', `${rev}:${file}`);
  return r.ok ? r.out : null;
};

const BRANCHES = [
  { name: 'rename-habit', tip: state.renameTip, test: 'tests/rename.test.js', title: 'Тесты переименования', feature: 'переименования' },
  { name: 'habit-emoji', tip: state.emojiTip, test: 'tests/emoji.test.js', title: 'Тесты значков', feature: 'значков' },
];
const MARKER = /^(<{7} |\|{7}( |$)|={7}$|>{7}( |$))/;

let merged = [];
const check = createCheck({ heading: 'Проверка практики «Слияние двух веток»' });

check.before(() => {
  merged = BRANCHES.filter((b) => isAncestor(b.tip, 'HEAD'));
});

check.criterion('ветка', () => {
  if (gitPathExists('MERGE_HEAD')) {
    const unmerged = g('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    return {
      ok: false,
      fail: unmerged.length ? `Слияние не завершено: конфликт в ${unmerged.join(', ')}` : 'Слияние не завершено',
      hint: 'разрешите конфликт, выполните git add и git commit --no-edit. Вернуться к началу слияния: git merge --abort.',
    };
  }
  if (gitPathExists('rebase-merge') || gitPathExists('rebase-apply')) {
    return { ok: false, fail: 'Идёт rebase', hint: 'в этой практике ветки сливают через git merge. Отменить rebase: git rebase --abort.' };
  }
  if (gitPathExists('REVERT_HEAD') || gitPathExists('CHERRY_PICK_HEAD')) {
    return { ok: false, fail: 'Не завершена другая операция Git', hint: 'git status покажет, что осталось, и подскажет, как её завершить или отменить.' };
  }
  const branch = g('symbolic-ref', '--short', 'HEAD');
  if (!branch.ok || branch.out !== 'main') {
    return { ok: false, fail: branch.ok ? `Сейчас ветка ${branch.out}, а не main` : 'Сейчас не ветка main: HEAD отсоединён', hint: 'переключитесь на ветку main: сливают в неё.' };
  }
  return { ok: true, pass: 'Ветка main, слияние не идёт' };
});

// Похоже на rebase или squash: тесты ветки в HEAD есть, а коммита ветки нет.
const copiedWithoutMerge = (b) => !isAncestor(b.tip, 'HEAD') && blob('HEAD', b.test) !== null && blob('HEAD', b.test) === blob(b.tip, b.test);
const REBASE_HINT = 'похоже, ветку перенесли через rebase или squash. Здесь нужен обычный git merge. Проще всего начать заново: переименуйте папку tracker и снова выполните npm run setup.';

check.criterion('влиты', () => {
  if (merged.length === BRANCHES.length) return { ok: true, pass: 'Обе ветки влиты: rename-habit и habit-emoji' };
  const missing = BRANCHES.filter((b) => !merged.includes(b));
  if (missing.some(copiedWithoutMerge)) {
    return { ok: false, fail: `Не влиты ветки: ${missing.map((b) => b.name).join(', ')}`, hint: REBASE_HINT };
  }
  if (missing.length === 2) {
    return { ok: false, fail: 'Не влиты ветки: rename-habit, habit-emoji', hint: 'влейте их в main по очереди через git merge.' };
  }
  const [b] = missing;
  return { ok: false, fail: `Не влита ветка ${b.name}`, hint: `ветка ${b.name} ещё не влита в main: git merge ${b.name}.` };
});

check.criterion('merge-коммит', () => {
  const merges = g('rev-list', '--min-parents=2', '--format=%H %P', `${state.mainStart}..HEAD`);
  const lines = merges.ok ? merges.out.split('\n').filter((l) => !l.startsWith('commit ')) : [];
  for (const line of lines) {
    const [hash, ...parents] = line.split(' ');
    const [rename, emoji] = BRANCHES;
    const joins = parents.some((p) => isAncestor(rename.tip, p) && !isAncestor(emoji.tip, p))
      && parents.some((p) => isAncestor(emoji.tip, p) && !isAncestor(rename.tip, p));
    if (joins) {
      const subject = g('log', '-1', '--format=%s', hash).out;
      return { ok: true, pass: `Слияние завершено merge-коммитом: ${subject}` };
    }
  }
  if (merged.length === BRANCHES.length) {
    return {
      ok: false,
      fail: 'Merge-коммита, который объединяет обе ветки, нет',
      hint: 'слияние прошло без merge-коммита. Так бывает, если одну ветку перенесли поверх другой. Начните заново и влейте ветки по очереди через git merge.',
    };
  }
  if (BRANCHES.some(copiedWithoutMerge)) {
    return { ok: false, fail: 'Merge-коммита, который объединяет обе ветки, нет', hint: REBASE_HINT };
  }
  return { ok: false, fail: 'Merge-коммита, который объединяет обе ветки, нет' };
});

check.criterion('маркеры', () => {
  const found = [];
  // Рабочая папка: все отслеживаемые файлы, включая неразрешённые.
  const files = [...new Set(g('ls-files').out.split('\n').filter(Boolean))];
  for (const file of files) {
    const full = path.join(TRACKER, file);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (MARKER.test(line)) found.push(`${file}:${i + 1}`);
    });
  }
  // Последний коммит.
  const inHead = g('grep', '-nE', '^(<{7} |[|]{7}( |$)|={7}$|>{7}( |$))', 'HEAD');
  if (inHead.ok) {
    for (const line of inHead.out.split('\n').filter(Boolean)) {
      const [, file, num] = line.split(':');
      if (!found.includes(`${file}:${num}`)) found.push(`${file}:${num}`);
    }
  }
  if (!found.length) return { ok: true, pass: 'Маркеров конфликта нет' };
  return {
    ok: false,
    fail: `В ${found[0]} остался маркер конфликта${found.length > 1 ? ` (всего строк с маркерами: ${found.length})` : ''}`,
    hint: 'git diff --check покажет все.',
  };
});

for (const b of BRANCHES) {
  check.criterion(b.title, () => {
    const inHead = blob('HEAD', b.test);
    if (inHead === null) return { ok: false, fail: `${b.title} в main нет` };
    if (inHead !== blob(b.tip, b.test)) {
      return {
        ok: false,
        fail: `${b.title} изменены`,
        hint: `тесты ${b.feature} изменены по сравнению с веткой. Конфликт разрешают в коде, тесты не трогают: верните файл из ветки (git checkout ${b.name} -- ${b.test}).`,
      };
    }
    const run = runNodeTests({ cwd: TRACKER, files: [b.test] });
    const count = `${run.pass} из ${run.tests}`;
    if (run.ok) return { ok: true, pass: `${b.title} не изменены и проходят: ${count}` };
    if (!run.failed.length) {
      return {
        ok: false,
        fail: `${b.title} не запускаются: код, который они проверяют, не загружается`,
        hint: 'посмотрите на критерий «Обе фичи вместе» ниже: там ошибка загрузки.',
      };
    }
    return {
      ok: false,
      fail: `${b.title} падают: проходят ${count}`,
      hint: `похоже, при разрешении конфликта потерялась часть ${b.feature} в render.js.`,
    };
  });
}

// Импорт кода в отдельном процессе: ошибка в render.js не роняет проверку.
const PROBE = `
const { pathToFileURL } = await import('node:url');
const url = (f) => pathToFileURL(f).href;
const result = {};
try {
  const { createTracker } = await import(url('tracker.js'));
  const { renderHabitRow } = await import(url('render.js'));
  const data = new Map();
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  const tracker = createTracker(storage);
  if (typeof tracker.rename !== 'function') result.noRename = true;
  else {
    const habit = tracker.add('Читать 10 минут', '📖');
    tracker.rename(habit.id, 'Читать 15 минут');
    const row = renderHabitRow(tracker.list()[0]);
    result.label = row.label;
    result.buttons = row.buttons;
  }
} catch (error) {
  result.error = { name: error.name, message: error.message, syntax: error instanceof SyntaxError };
}
console.log(JSON.stringify(result));
`;

check.criterion('вместе', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { cwd: TRACKER, encoding: 'utf8', timeout: 30_000 });
  let result;
  try {
    result = JSON.parse((run.stdout ?? '').trim().split('\n').pop());
  } catch {
    const first = (run.stderr ?? '').trim().split('\n').find((l) => /Error/.test(l)) ?? 'код не загрузился';
    return { ok: false, fail: 'Обе фичи вместе: код не загружается', details: first };
  }
  if (result.error) {
    const { message } = result.error;
    let hint = 'посмотрите на ошибку выше и на файл, где она возникла.';
    if (/has already been declared/.test(message)) {
      hint = 'render.js не загружается: в функции дважды объявлено одно имя. Похоже на «принять обе стороны» без правки.';
    } else if (/'<<'|'==='|'>>'|'\|\|'/.test(message)) {
      hint = 'в коде остались маркеры конфликта. Уберите их, оставив нужные строки.';
    }
    return {
      ok: false,
      fail: 'Обе фичи вместе: render.js или tracker.js не загружается',
      details: `${result.error.name}: ${message}`,
      hint,
    };
  }
  if (result.noRename) return { ok: false, fail: 'Обе фичи вместе: в tracker.js нет функции rename' };
  const problems = [];
  if (result.label !== '📖 Читать 15 минут') problems.push(`подпись «${result.label}» вместо «📖 Читать 15 минут»`);
  for (const name of ['Переименовать', 'Удалить']) if (!result.buttons?.includes(name)) problems.push(`нет кнопки «${name}»`);
  if (!problems.length) return { ok: true, pass: 'Обе фичи вместе: «📖 Читать 15 минут», кнопки «Переименовать» и «Удалить»' };
  return { ok: false, fail: `Обе фичи вместе: ${problems.join(', ')}`, hint: 'в render.js нужна подпись из habit-emoji и кнопки из rename-habit.' };
});

check.criterion('тесты', () => {
  const run = runNodeTests({ cwd: TRACKER, files: [] });
  const count = `${run.pass} из ${run.tests}`;
  if (run.ok) return { ok: true, pass: `npm test: ${count} тестов проходят` };
  return { ok: false, fail: `npm test: ${count} тестов проходят`, hint: 'тесты падают — посмотрите, какой тест и что он ожидал.' };
});

check.criterion('чисто', () => {
  const status = g('status', '--porcelain');
  if (status.ok && status.out === '') return { ok: true, pass: 'Рабочая папка чистая' };
  return { ok: false, fail: 'В рабочей папке есть незакоммиченные изменения', hint: 'git status --short покажет, какие.' };
});

await check.run();
