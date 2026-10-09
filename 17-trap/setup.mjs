// Создаёт учебную приманку streak-cli вне набора, по умолчанию в ~/trap-17.
//
//   npm run setup                       создать ~/trap-17
//   npm run setup -- --dest <папка>     создать в другой папке
//   npm run setup -- --reset            пересоздать (ваш .claude/settings.local.json сохраняется)
//
// Удаляет папку только при --reset и только если в ней есть метка .git/kit17-trap.
// Путь приманки записывается в .trap-path рядом с этим файлом: его читает npm run check.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures/trap');
const TRAP_PATH_FILE = path.join(HERE, '.trap-path');
const MARK = path.join('.git', 'kit17-trap');
const LOCAL_SETTINGS = path.join('.claude', 'settings.local.json');
const RENAMES = { 'env.txt': '.env' };
const AUTHOR = { name: 'streak-cli maintainers', email: 'maintainers@example.invalid', date: '2026-10-03T10:00:00Z' };

const say = (lines) => {
  for (const line of [lines].flat()) console.log(line);
};
const fail = (lines, code = 1) => {
  say(lines);
  process.exit(code);
};

// 1. Версии
if (Number(process.versions.node.split('.')[0]) < 22) {
  fail(`Нужен Node.js 22 или новее, сейчас ${process.version}. Установите его с nodejs.org и снова выполните npm run setup.`);
}
let values;
try {
  ({ values } = parseArgs({ options: { dest: { type: 'string' }, reset: { type: 'boolean' } }, strict: true, allowPositionals: false }));
} catch {
  fail('Неизвестный параметр. Запуск: npm run setup, npm run setup -- --reset или npm run setup -- --dest <папка>.', 2);
}
const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitVersion.error || gitVersion.status !== 0) fail('Не найден Git. Установите Git с git-scm.com и снова выполните npm run setup.');

// 2. Папка назначения
const home = os.homedir();
const expandHome = (p) => (p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p);
const tilde = (p) => (p === home ? '~' : p.startsWith(home + path.sep) ? `~/${path.relative(home, p).split(path.sep).join('/')}` : p);
// realpath для пути, которого ещё может не быть: ближайший существующий предок + остаток.
const realish = (p) => {
  let base = p;
  const rest = [];
  while (!existsSync(base)) {
    rest.unshift(path.basename(base));
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }
  try {
    return path.join(realpathSync(base), ...rest);
  } catch {
    return p;
  }
};
const dest = path.resolve(expandHome(values.dest ?? path.join(home, 'trap-17')));
const insideKit = (() => {
  const rel = path.relative(realish(KIT_ROOT), realish(dest));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
})();
if (insideKit) {
  fail([
    `Папка ${dest} лежит внутри набора: агент, открытый в приманке, прочитает разбор и проверку.`,
    'Укажите папку вне набора: npm run setup -- --dest <папка> или запустите без --dest (будет ~/trap-17).',
  ], 2);
}
const resetHint = values.dest ? `npm run setup -- --reset --dest ${values.dest}` : 'npm run setup -- --reset';

let savedSettings = null;
if (existsSync(dest)) {
  if (!values.reset) fail(`Папка ${tilde(dest)} уже есть. Для сброса: ${resetHint}`, 2);
  if (!existsSync(path.join(dest, MARK))) {
    fail([
      `В папке ${tilde(dest)} нет метки ${MARK.split(path.sep).join('/')}: это не приманка из набора. Ничего не удалено.`,
      'Переименуйте папку или укажите другую: npm run setup -- --dest <папка>.',
    ], 2);
  }
  const settingsFile = path.join(dest, LOCAL_SETTINGS);
  if (existsSync(settingsFile)) savedSettings = readFileSync(settingsFile);
}

// Резервная копия личных настроек на время пересоздания.
let backupDir = null;
if (savedSettings) {
  backupDir = mkdtempSync(path.join(os.tmpdir(), 'kit17-settings-'));
  writeFileSync(path.join(backupDir, 'settings.local.json'), savedSettings);
}

// Служебные команды Git не читают глобальные настройки и хуки студента.
const env = { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|CEILING_DIRECTORIES)$/.test(key)) delete env[key];
Object.assign(env, {
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: AUTHOR.date,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: AUTHOR.date,
});
const SAFE = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.fileMode=false'];
function git(args) {
  const result = spawnSync('git', [...SAFE, ...args], { cwd: dest, env, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

// Список файлов приманки с путями в Git (env.txt становится .env и в Git не попадает).
function fixtureFiles(dir = FIXTURES, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...fixtureFiles(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files.sort();
}

let setupError = null;
try {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  // 3. Файлы приманки
  const tracked = [];
  for (const rel of fixtureFiles()) {
    const target = RENAMES[rel] ?? rel;
    mkdirSync(path.dirname(path.join(dest, target)), { recursive: true });
    cpSync(path.join(FIXTURES, rel), path.join(dest, target));
    if (!RENAMES[rel]) tracked.push(target);
  }

  // 4. Репозиторий с одним коммитом, одинаковым на любой машине
  git(['init', '--quiet', '--template=']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['add', '--force', '--', ...tracked]);
  git(['commit', '--quiet', '--no-verify', '-m', 'Initial import']);

  // 5. Метка, личные настройки, путь для проверки
  writeFileSync(path.join(dest, MARK), '');
  if (savedSettings) {
    mkdirSync(path.join(dest, '.claude'), { recursive: true });
    writeFileSync(path.join(dest, LOCAL_SETTINGS), savedSettings);
  }
  writeFileSync(TRAP_PATH_FILE, `${realpathSync(dest)}\n`);
} catch (error) {
  setupError = error;
}

if (setupError) {
  rmSync(dest, { recursive: true, force: true });
  fail([
    `Не удалось создать приманку: ${setupError.message}`,
    ...(backupDir ? [`Ваш .claude/settings.local.json сохранён в ${path.join(backupDir, 'settings.local.json')}.`] : []),
  ]);
}
if (backupDir) rmSync(backupDir, { recursive: true, force: true });

// 6. Готово
say([
  `Готово: приманка создана в ${realpathSync(dest)}.`,
  ...(savedSettings ? ['Ваш .claude/settings.local.json сохранён.'] : []),
  'Откройте эту папку в агенте и следуйте шагам практики.',
  'Учебная ловушка безопасна: npm run setup-cache только создаёт файл .canary-triggered.',
]);
