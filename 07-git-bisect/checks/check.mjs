// Автопроверка практики «Сломать и вернуть».
// Запуск: npm run check в папке 07-git-bisect/tracker.
// Проверка только читает репозиторий и запускает тесты, ничего не меняет.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheck, git, runNodeTests } from './kit-check.mjs';

const PRACTICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACKER = path.join(PRACTICE, 'tracker');
const STATE_FILE = path.join(PRACTICE, '.kit/state.json');

if (!existsSync(STATE_FILE) || !existsSync(path.join(TRACKER, '.git'))) {
  console.log('Сначала выполните npm run setup в папке 07-git-bisect');
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const g = (...args) => git(TRACKER, args);
const short = (hash) => hash.slice(0, 7);
const gitPathExists = (name) => {
  const rel = g('rev-parse', '--git-path', name);
  return rel.ok && existsSync(path.resolve(TRACKER, rel.out));
};

// Сведения, нужные нескольким критериям, собираются заранее.
let tests;
let reverted = [];
let culpritReverted = false;

const check = createCheck({ heading: 'Проверка практики «Сломать и вернуть»' });

check.before(() => {
  tests = runNodeTests({ cwd: TRACKER, files: [] });
  const range = g('log', '--format=%H%x00%B%x00%x01', `${state.originalHead}..HEAD`);
  if (range.ok) {
    for (const entry of range.out.split('\x01')) {
      const [hash, body = ''] = entry.replace(/^\n/, '').split('\x00');
      for (const match of body.matchAll(/This reverts commit ([0-9a-f]{7,40})\./g)) reverted.push({ hash, target: match[1] });
    }
  }
  culpritReverted = reverted.some(({ target }) => state.culprit.startsWith(target));
});

check.criterion('ветка', () => {
  const name = 'Ветка main, поиск bisect не идёт';
  if (gitPathExists('BISECT_START') || gitPathExists('BISECT_LOG')) {
    return { ok: false, fail: 'Идёт поиск git bisect', hint: 'Поиск ещё идёт: выполните git bisect reset и снова запустите проверку.' };
  }
  if (gitPathExists('REVERT_HEAD')) {
    return { ok: false, fail: 'Отмена коммита не завершена', hint: 'Отмена не завершена: git status покажет, что осталось.' };
  }
  if (gitPathExists('MERGE_HEAD') || gitPathExists('CHERRY_PICK_HEAD') || gitPathExists('rebase-merge') || gitPathExists('rebase-apply')) {
    return { ok: false, fail: 'Не завершена другая операция Git', hint: 'git status покажет, что осталось, и подскажет, как её завершить или отменить.' };
  }
  const branch = g('symbolic-ref', '--short', 'HEAD');
  if (!branch.ok || branch.out !== 'main') {
    return { ok: false, fail: branch.ok ? `Сейчас ветка ${branch.out}, а не main` : 'Сейчас не ветка main: HEAD отсоединён', hint: 'Переключитесь на ветку main.' };
  }
  return { ok: true, pass: name };
});

check.criterion('история', () => {
  const ancestor = g('merge-base', '--is-ancestor', state.originalHead, 'HEAD').ok;
  const count = Number(g('rev-list', '--count', state.originalHead).out || 0);
  if (ancestor && count === state.commitCount) {
    return { ok: true, pass: `История не переписана: ${state.commitCount} исходных коммитов на месте` };
  }
  return {
    ok: false,
    fail: 'История переписана: исходные коммиты пропали из main',
    hint: 'Похоже на git reset или rebase. Проще всего начать заново: переименуйте папку tracker и снова выполните npm run setup.',
  };
});

check.criterion('revert', () => {
  if (culpritReverted) {
    return { ok: true, pass: `Виновный коммит отменён через git revert: «${state.culpritSubject}»` };
  }
  const other = reverted.find(({ target }) => !state.culprit.startsWith(target));
  if (other) {
    const subject = g('log', '-1', '--format=%s', other.target).out || other.target;
    return {
      ok: false,
      fail: 'Отменён не тот коммит',
      hint: `Отменён коммит «${subject}», но счётчик ломает другой. Отмените эту отмену тоже через git revert и продолжите поиск.`,
    };
  }
  return {
    ok: false,
    fail: 'Коммит со сломанным счётчиком не отменён',
    hint: 'найдите его через git bisect run npm test и отмените через git revert.',
  };
});

check.criterion('дерево', () => {
  const tree = g('rev-parse', 'HEAD^{tree}');
  if (tree.ok && tree.out === state.expectedTree) return { ok: true, pass: 'Код совпадает с ожидаемым: правок руками нет' };
  if (tests.ok) {
    return {
      ok: false,
      fail: 'Код отличается от ожидаемого',
      hint: 'тесты проходят, но код получен не отменой коммита. В этой практике исправление — git revert найденного коммита, без правок руками.',
    };
  }
  if (culpritReverted) {
    return {
      ok: false,
      fail: 'Код отличается от ожидаемого',
      hint: `сравните git diff ${short(state.culprit)}~1 ${short(state.culprit)} с тем, что вы изменили.`,
    };
  }
  return { ok: false, fail: 'Код отличается от ожидаемого', hint: 'исправление в этой практике — git revert найденного коммита.' };
});

check.criterion('тесты', () => {
  const count = `${tests.pass} из ${tests.tests}`;
  if (tests.ok) return { ok: true, pass: `npm test: ${count} тестов проходят` };
  if (tests.timedOut) return { ok: false, fail: 'npm test: тесты не завершились за 60 секунд', hint: 'похоже, тест завис. Запустите npm test и посмотрите, на каком тесте он остановился.' };
  return { ok: false, fail: `npm test: ${count} тестов проходят`, hint: 'тесты падают — посмотрите, какой тест и что он ожидал.' };
});

check.criterion('чисто', () => {
  const status = g('status', '--porcelain');
  if (status.ok && status.out === '') return { ok: true, pass: 'Рабочая папка чистая' };
  return { ok: false, fail: 'В рабочей папке есть незакоммиченные изменения', hint: 'git status --short покажет, какие.' };
});

await check.run();
