// Разворачивает учебный проект из tracker.bundle в папку tracker и
// записывает служебные данные для автопроверки в .kit/state.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKER = path.join(HERE, 'tracker');
const KIT_DIR = path.join(HERE, '.kit');
const BUNDLE = path.join(HERE, 'tracker.bundle');
const GOOD_SUBJECT = 'Счётчик выполненных';
const CULPRIT_SUBJECT = 'Вынести тексты интерфейса в один файл';
const COMMIT_COUNT = 8;

const say = (text) => console.log(text);
const fail = (text) => {
  say(text);
  process.exit(1);
};

// Чужие хуки и подпись студента не должны мешать служебным командам.
let emptyHooks;
const SAFE = [];
const env = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(key)) delete env[key];

function git(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', [...SAFE, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

// 1. Версии
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  fail(`Нужен Node.js 22 или новее, сейчас ${process.version}. Установите его с nodejs.org и снова выполните npm run setup.`);
}
const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
const gitMatch = /(\d+)\.(\d+)/.exec(gitVersion.stdout ?? '');
if (gitVersion.error || !gitMatch) fail('Не найден Git. Установите Git 2.23 или новее с git-scm.com и снова выполните npm run setup.');
const [gitMajor, gitMinor] = [Number(gitMatch[1]), Number(gitMatch[2])];
if (gitMajor < 2 || (gitMajor === 2 && gitMinor < 23)) {
  fail(`Нужен Git 2.23 или новее, сейчас ${gitMatch[0]}. Обновите его с git-scm.com и снова выполните npm run setup.`);
}

// 2. Не трогаем существующую папку
if (existsSync(TRACKER)) {
  fail('Папка tracker уже есть. Чтобы начать заново, переименуйте или удалите её и снова выполните npm run setup.');
}
if (!existsSync(BUNDLE)) fail('Не найден файл tracker.bundle. Скачайте набор заново: git clone https://github.com/guidedao/vibecoding-kit');

emptyHooks = mkdtempSync(path.join(os.tmpdir(), 'kit-hooks-'));
SAFE.push('-c', `core.hooksPath=${emptyHooks}`, '-c', 'commit.gpgsign=false');
let tmpClone;
let setupError;
try {
  // 3. Репозиторий с веткой main из бандла, без remote
  git(HERE, ['init', '--quiet', TRACKER]);
  git(TRACKER, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(TRACKER, ['fetch', '--quiet', '--update-head-ok', BUNDLE, 'refs/heads/*:refs/heads/*']);
  git(TRACKER, ['reset', '--quiet', '--hard', 'HEAD']);

  // 4. Подпись для коммитов студента, если её нет
  const email = spawnSync('git', ['config', '--get', 'user.email'], { cwd: TRACKER, env, encoding: 'utf8' });
  if (!(email.stdout ?? '').trim()) {
    git(TRACKER, ['config', 'user.name', 'Студент']);
    git(TRACKER, ['config', 'user.email', 'student@example.invalid']);
    say('В Git не задано имя автора: в папке tracker коммиты будут подписаны «Студент».');
  }

  // 5. Хеши для проверки
  const log = git(TRACKER, ['log', '--format=%H%x09%s', 'main']).split('\n').map((line) => line.split('\t'));
  if (log.length !== COMMIT_COUNT) throw new Error(`в истории ${log.length} коммитов вместо ${COMMIT_COUNT}`);
  const find = (subject) => log.find(([, s]) => s === subject)?.[0];
  const originalHead = git(TRACKER, ['rev-parse', 'HEAD']);
  const good = find(GOOD_SUBJECT);
  const culprit = find(CULPRIT_SUBJECT);
  if (!good || !culprit) throw new Error('в истории нет ожидаемых коммитов');

  // 6. Ожидаемое дерево: отмена виновного коммита во временной копии
  tmpClone = mkdtempSync(path.join(os.tmpdir(), 'kit-07-bisect-'));
  git(tmpClone, ['clone', '--quiet', '--no-hardlinks', TRACKER, '.']);
  const kitIdentity = {
    GIT_AUTHOR_NAME: 'Трекер (учебная история)',
    GIT_AUTHOR_EMAIL: 'kit@example.invalid',
    GIT_COMMITTER_NAME: 'Трекер (учебная история)',
    GIT_COMMITTER_EMAIL: 'kit@example.invalid',
  };
  git(tmpClone, ['revert', '--no-edit', culprit], kitIdentity);
  const expectedTree = git(tmpClone, ['rev-parse', 'HEAD^{tree}']);

  // 7. Служебный файл
  mkdirSync(KIT_DIR, { recursive: true });
  writeFileSync(
    path.join(KIT_DIR, 'state.json'),
    `${JSON.stringify({ originalHead, good, culprit, culpritSubject: CULPRIT_SUBJECT, expectedTree, commitCount: COMMIT_COUNT }, null, 2)}\n`,
  );
} catch (error) {
  rmSync(TRACKER, { recursive: true, force: true });
  rmSync(KIT_DIR, { recursive: true, force: true });
  setupError = error;
} finally {
  if (tmpClone) rmSync(tmpClone, { recursive: true, force: true });
  rmSync(emptyHooks, { recursive: true, force: true });
}
if (setupError) fail(`Не удалось развернуть учебный проект: ${setupError.message}`);

// 8. Готово
say(`Готово: tracker, ${COMMIT_COUNT} коммитов в ветке main.`);
say('Начните новую сессию агента в папке 07-git-bisect/tracker.');
