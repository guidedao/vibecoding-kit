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
const BRANCHES = ['main', 'rename-habit', 'habit-emoji'];

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
let setupError;
try {
  // 3. Репозиторий с ветками из бандла, без remote; текущая ветка main
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
  const heads = Object.fromEntries(BRANCHES.map((b) => [b, git(TRACKER, ['rev-parse', `refs/heads/${b}`])]));
  const status = git(TRACKER, ['status', '--porcelain']);
  if (status) throw new Error('рабочая папка не чистая после развёртывания');

  // 6. Служебный файл
  mkdirSync(KIT_DIR, { recursive: true });
  writeFileSync(
    path.join(KIT_DIR, 'state.json'),
    `${JSON.stringify({ mainStart: heads.main, renameTip: heads['rename-habit'], emojiTip: heads['habit-emoji'] }, null, 2)}\n`,
  );
} catch (error) {
  rmSync(TRACKER, { recursive: true, force: true });
  rmSync(KIT_DIR, { recursive: true, force: true });
  setupError = error;
} finally {
  rmSync(emptyHooks, { recursive: true, force: true });
}
if (setupError) fail(`Не удалось развернуть учебный проект: ${setupError.message}`);

// 7. Готово
say('Готово: tracker, ветки main, rename-habit и habit-emoji.');
say('Начните новую сессию агента в папке 07-merge-conflict/tracker.');
