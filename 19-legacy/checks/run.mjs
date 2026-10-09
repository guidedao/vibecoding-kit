// Автопроверка практики 19-legacy «Оживить заброшенный проект».
//
// Проверяет учебный проект в папке ../journal по восьми критериям. Проект
// не меняется никогда: вся работа идёт во временных копиях
// <tmp>/journal-check-*, которые удаляются в конце и по Ctrl+C.
//
// Коды выхода: 0 — все 8 критериев пройдены, 1 — хотя бы один не пройден,
// 2 — проверку нельзя провести (Node, Git, нет папки journal),
// 3 — сбой самой проверки (мутация не применилась, проверка изменила проект).
//
// Только встроенные модули Node.js 22+.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCheck, git, parseTap } from './kit-check.mjs';
import { CONTRACT, CONTRACT_HINT, MUTANTS, buildWrapper, origName } from './mutants.mjs';
import { auditReadme, MIN_NODE, planReadme } from './readme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOURNAL = path.resolve(HERE, '..', 'journal');
const EXPECTED_MAJOR = 5;
const MIN_TESTS = 8;
const INSTALL_TIMEOUT = 180;
const TEST_TIMEOUT = 120;
const SERVER_WAIT_MS = 15_000;
const STOP_GRACE_MS = 3000;
const DATA_FILE = 'data/journal.json';
const SENTINEL = `${JSON.stringify([{ id: 'journal-check-sentinel', date: '2000-01-01', title: 'Запись пользователя', pages: 1 }], null, 2)}\n`;

const NOT_INSTALLED = 'не проверялось, нужна установка';
const README_HINT = 'сверьте раздел «Запуск» в README со scripts и .env.example; запуск должен работать на свежей копии без ручных шагов.';
const CLEAN_COPY_HINT = 'Тесты падают в чистой копии проекта. Частая причина — тест читает .env или пишет в data/journal.json. Тест должен сам создать временный файл данных и передать его в createApp.';

// ---------- служебное

const temps = new Set();
const children = new Set();
let interrupted = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTemp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'journal-check-'));
  temps.add(dir);
  return dir;
}
function removeTemp(dir) {
  if (!dir) return;
  rmSync(dir, { recursive: true, force: true });
  temps.delete(dir);
}
function removeTemps() {
  for (const dir of [...temps]) removeTemp(dir);
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // группы уже нет
  }
}
/** Останавливает группу процессов: SIGTERM, через 3 секунды SIGKILL. */
async function stopChild(child) {
  if (!child) return;
  killGroup(child, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (!exited(child) && Date.now() < deadline) await sleep(100);
  killGroup(child, 'SIGKILL');
  children.delete(child);
}
async function stopChildren() {
  await Promise.all([...children].map(stopChild));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (interrupted) return;
    interrupted = true;
    await stopChildren();
    removeTemps();
    process.stdout.write('\nПроверка прервана. Временные копии удалены.\n');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

/** Окружение дочерних процессов: без переменных npm родителя и без лишнего. */
function childEnv({ drop = [], extra = {} } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) || ['INIT_CWD', 'NODE_TEST_CONTEXT'].includes(key) || drop.includes(key)) continue;
    env[key] = value;
  }
  return { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', NO_COLOR: '1', ...extra };
}

/** Запуск в своей группе процессов; Ctrl+C получает проверка и сама гасит дерево. */
function run(command, args, { cwd, env, timeoutSec }) {
  return new Promise((resolve) => {
    // После Ctrl+C обещание не выполняется: проверка ждёт выхода из обработчика сигнала
    // и не печатает критерии по оборванным прогонам.
    if (interrupted) return;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
    }, timeoutSec * 1000);
    child.on('error', (error) => { stderr += String(error.message); });
    child.on('close', (status) => {
      clearTimeout(timer);
      children.delete(child);
      killGroup(child, 'SIGKILL');
      if (interrupted) return;
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function wrap(prefix, text, cont = ' '.repeat(prefix.length), width = 76) {
  const lines = [];
  let line = prefix;
  for (const word of String(text).split(' ')) {
    if (line.trim() && line.length + word.length > width) {
      lines.push(line.trimEnd());
      line = cont;
    }
    line += `${word} `;
  }
  lines.push(line.trimEnd());
  return lines;
}

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
const lastLines = (text, n) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n);
const firstLines = (text, n) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, n);

function walk(dir, test, root = dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, test, root));
    else if (test(entry.name)) found.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return found.sort();
}

// ---------- снимок проекта

function projectFiles() {
  const res = git(JOURNAL, ['ls-files', '-co', '--exclude-standard', '-z']);
  return res.out.split('\0').filter((f) => f && !f.split('/').includes('node_modules')).sort();
}

function snapshot(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    const full = path.join(JOURNAL, file);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      hash.update('-missing-');
      continue;
    }
    if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(full)}`);
    else if (stat.isFile()) hash.update(readFileSync(full));
  }
  return hash.digest('hex');
}

function copyFiles(files, target) {
  for (const file of files) {
    const from = path.join(JOURNAL, file);
    let stat;
    try {
      stat = lstatSync(from);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    cpSync(from, path.join(target, file), { verbatimSymlinks: true });
  }
}

/** Копия папки C (или journal) без node_modules и .git, node_modules — ссылка на C. */
function linkedCopy(source, nodeModulesFrom) {
  const dir = makeTemp();
  cpSync(source, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(source, src);
      return !rel || !['node_modules', '.git'].includes(rel.split(path.sep)[0]);
    },
  });
  const modules = path.join(nodeModulesFrom, 'node_modules');
  if (existsSync(modules)) symlinkSync(realpathSync(modules), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

// ---------- состояние проверки

let C = null;
let files = [];
let before = null;
let installed = false;
let server = null;
let serverPort = null;
let launch = null;
let testFiles = [];
let testsGreen = false;
const notes = [];
const note = (text) => {
  if (!notes.includes(text)) notes.push(text);
};

// ---------- тесты

function countTap(text, key) {
  let value = 0;
  for (const m of text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))) value = Number(m[1]);
  return value;
}

async function runTests(dir) {
  const res = await run(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
    cwd: dir,
    env: childEnv({ drop: ['PORT', 'JOURNAL_FILE'] }),
    timeoutSec: TEST_TIMEOUT,
  });
  const tap = parseTap(res.stdout, { cwd: dir });
  const skipped = countTap(res.stdout, 'skipped');
  const todo = countTap(res.stdout, 'todo');
  const failCount = tap.failCount || (!res.timedOut && res.status !== 0 && !tap.failCount ? 1 : 0);
  return {
    ...tap,
    skipped,
    todo,
    failCount,
    timedOut: res.timedOut,
    status: res.status,
    output: `${res.stdout}\n${res.stderr}`,
    names: [...tap.failed, ...tap.failedFiles.map((f) => `не запустился файл ${f}`)],
    green: !res.timedOut && res.status === 0 && tap.hasSummary && tap.failCount === 0 && skipped === 0 && todo === 0,
  };
}

const STATIC_RULES = [/\.(skip|only|todo)\s*\(/, /\{\s*(skip|todo|only)\s*:/];

// ---------- HTTP

async function request(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', body };
}

async function waitForServer(child, port) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + SERVER_WAIT_MS;
  let lastError = '';
  while (Date.now() < deadline && !exited(child) && !interrupted) {
    try {
      const page = await request(`${base}/`);
      if (page.status === 200 && page.type.includes('text/html')) {
        const list = await request(`${base}/api/entries`);
        let parsed = null;
        try {
          parsed = JSON.parse(list.body);
        } catch {
          // не JSON
        }
        if (list.status === 200 && Array.isArray(parsed)) return { ok: true };
        return { ok: false, reason: `GET /api/entries ответил ${list.status}${Array.isArray(parsed) ? '' : ', а не JSON-массивом'}.` };
      }
      lastError = `GET / ответил ${page.status} (${page.type || 'без типа'}), ожидается 200 и HTML.`;
    } catch (error) {
      lastError = error?.cause?.code ?? error?.message ?? String(error);
    }
    await sleep(250);
  }
  if (exited(child)) return { ok: false, reason: `Сервер завершился с кодом ${child.exitCode ?? child.signalCode}.` };
  return { ok: false, reason: `Сервер не ответил за ${SERVER_WAIT_MS / 1000} секунд${lastError && /ответил/.test(lastError) ? `: ${lastError}` : '.'}` };
}

// ---------- проверка

const check = createCheck({
  heading: 'Автопроверка 19-legacy: журнал чтения после сопровождения\nПроверка займёт до двух минут.',
  renderCriterion: ({ index, name, ok, word, detail, details = [], hint, sub = [] }) => [
    `${index}. ${name}: ${word ?? (ok ? 'да' : 'нет')}${detail ? ` (${detail})` : ''}`,
    ...details.flatMap((line) => wrap('   ', line)),
    ...sub,
    ...(hint ? wrap('   Подсказка: ', hint, '   ') : []),
  ],
  renderSummary: ({ passed, total }) => {
    const lines = ['', `Итог: ${passed} из ${total}.`];
    if (notes.length) lines.push('', 'Заметки:', ...notes.flatMap((n) => wrap('- ', n, '  ')));
    return lines;
  },
});

check.before((ctx) => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) ctx.stop([`Нужен Node.js ${MIN_NODE} или новее, сейчас ${process.version}.`]);
  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitVersion.error || gitVersion.status !== 0) ctx.stop(['Не найден Git. Установите Git 2.30 или новее.']);
  const top = existsSync(JOURNAL) ? git(JOURNAL, ['rev-parse', '--show-toplevel']) : { ok: false };
  if (!top.ok || realpathSync(top.out) !== realpathSync(JOURNAL)) ctx.stop(['Нет папки journal. Выполните npm run setup.']);

  files = projectFiles();
  before = snapshot(files);
  if (git(JOURNAL, ['status', '--porcelain']).out.trim()) {
    note('Есть незакоммиченные изменения: проверка видит их, но в истории их нет.');
  }
  C = makeTemp();
  copyFiles(files, C);

  const dupes = walk(path.join(C, 'src'), (n) => /\.m?js$/.test(n))
    .filter((f) => readFileSync(path.join(C, 'src', f), 'utf8').includes('slice(0, 7) === month'))
    .map((f) => `src/${f}`);
  if (dupes.length >= 2) {
    note(`Похоже, правило «запись относится к месяцу» всё ещё записано в двух местах (${dupes.join(', ')}).`);
  }
});

// 1. Чистая установка
check.criterion('Чистая установка (npm ci)', async () => {
  const res = await run('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
    cwd: C,
    env: childEnv({ drop: ['PORT', 'JOURNAL_FILE'] }),
    timeoutSec: INSTALL_TIMEOUT,
  });
  installed = res.status === 0 && !res.timedOut;
  if (installed) return { ok: true };
  const errors = res.timedOut
    ? [`npm ci не завершился за ${INSTALL_TIMEOUT} секунд.`]
    : firstLines((res.stderr || res.stdout).replace(/^npm (error|ERR!)\s*$/gm, ''), 15);
  return {
    ok: false,
    sub: errors.map((line) => `   ${line}`),
    hint: 'проверка ставит зависимости командой npm ci по package-lock.json проекта. Lock-файл должен быть в Git и совпадать с package.json; меняйте зависимости через npm install, а не правкой файлов.',
  };
});

// 2. Запуск по README
check.criterion('Запуск по README', async () => {
  if (!installed) return { ok: false, word: NOT_INSTALLED };
  const readme = readText(path.join(C, 'README.md'));
  const pkg = readJson(path.join(C, 'package.json'));
  const findings = [];
  const extra = [];
  if (readme === null) findings.push('В проекте нет README.md.');
  if (!pkg) findings.push('package.json не читается как JSON.');
  const plan = planReadme(readme ?? '');
  plan.notes.forEach(note);
  launch = plan.launch;
  let serverOk = false;

  if (readme !== null && !plan.section) {
    findings.push('В README нет раздела «Запуск» с блоком команд. Проверка выполняет команды из этого блока.');
  }
  if (plan.section) {
    for (const step of plan.steps) {
      const res = spawnSync(step.cmd, step.args, { cwd: C, encoding: 'utf8', env: childEnv() });
      if (res.status !== 0) findings.push(`Строка README не выполнилась: ${step.line} (${(res.stderr || res.error?.message || '').trim()})`);
    }
    if (!launch) findings.push('В разделе «Запуск» нет команды запуска: npm start, npm run <скрипт> или node <файл>.');
    else if (launch.kind === 'npm' && !pkg?.scripts?.[launch.script]) {
      findings.push(launch.script === 'start'
        ? 'README велит npm start, а в package.json нет скрипта start.'
        : `README велит npm run ${launch.script}, а в package.json нет скрипта ${launch.script}.`);
    } else {
      serverPort = await freePort();
      const env = childEnv({ drop: ['JOURNAL_FILE'], extra: { PORT: String(serverPort) } });
      const [cmd, args] = launch.kind === 'npm' ? ['npm', launch.script === 'start' ? ['start', ...launch.args] : launch.args] : [process.execPath, launch.args];
      server = spawn(cmd, args, { cwd: C, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      children.add(server);
      server.output = '';
      const collect = (chunk) => {
        server.output = (server.output + chunk).slice(-100_000);
      };
      server.stdout.on('data', collect);
      server.stderr.on('data', collect);
      server.on('error', (error) => collect(String(error.message)));
      const ready = await waitForServer(server, serverPort);
      if (interrupted) await new Promise(() => {});
      serverOk = ready.ok;
      if (!ready.ok) {
        findings.push(`${ready.reason} Команда из README: ${launch.line}`);
        extra.push(...lastLines(server.output, 15).map((l) => `  ${l}`));
        await stopChild(server);
        server = null;
      }
    }
  }

  const hasTests = walk(path.join(C, 'tests'), (n) => /\.test\.m?js$/.test(n)).length > 0;
  const audit = auditReadme({
    readme: readme ?? '',
    pkg,
    nvmrc: readText(path.join(C, '.nvmrc')),
    nodeVersion: process.version,
    hasTests,
  });
  for (const f of audit.findings) if (!findings.includes(f)) findings.push(f);
  audit.notes.forEach(note);

  if (!findings.length && serverOk) return { ok: true, detail: `${launch.line}; страница и /api/entries отвечают` };
  const details = [];
  for (const f of findings) {
    details.push(f);
    if (/^(Сервер|GET)/.test(f)) details.push(...extra);
  }
  return { ok: false, details, hint: README_HINT };
});

// 3. Тесты
check.criterion('Тесты', async () => {
  if (!installed) return { ok: false, word: NOT_INSTALLED };
  testFiles = walk(path.join(C, 'tests'), (n) => /\.test\.m?js$/.test(n)).map((f) => `tests/${f}`);
  if (!testFiles.length) return { ok: false, details: ['Тестов пока нет: tests/*.test.js.'] };

  const hits = [];
  for (const file of walk(path.join(C, 'tests'), (n) => /\.(m?js|cjs)$/.test(n))) {
    readFileSync(path.join(C, 'tests', file), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (STATIC_RULES.some((rule) => rule.test(line))) hits.push(`  tests/${file}:${i + 1}  ${line.trim().slice(0, 60)}`);
    });
  }
  if (hits.length) {
    return {
      ok: false,
      details: ['В тестах есть пропущенные или выделенные тесты:'],
      sub: hits.map((h) => `   ${h.trimStart()}`),
      hint: 'уберите skip, only и todo: пропущенный тест ничего не проверяет, а test.only молча выключает остальные.',
    };
  }

  // Данные пользователя: тест не должен трогать data/journal.json проекта.
  const dataPath = path.join(C, DATA_FILE);
  const dataBefore = readText(dataPath);
  mkdirSync(path.dirname(dataPath), { recursive: true });
  writeFileSync(dataPath, SENTINEL);
  const result = await runTests(C);
  const dataTouched = readText(dataPath) !== SENTINEL;
  if (dataBefore === null) rmSync(dataPath, { force: true });
  else writeFileSync(dataPath, dataBefore);

  const deprecated = (result.output.match(/express deprecated/g) ?? []).length;
  if (deprecated) note(`В выводе тестов есть предупреждения express deprecated: ${deprecated}.`);

  const failed = result.failCount > 0 || result.timedOut || !result.hasSummary;
  let studentGreen = false;
  if (failed && !dataTouched && !result.timedOut) {
    // Как у студента: со своими .env и data/.
    const s = linkedCopy(JOURNAL, C);
    studentGreen = (await runTests(s)).green;
    removeTemp(s);
  }

  testsGreen = result.green && result.pass >= MIN_TESTS && !dataTouched;
  if (testsGreen) return { ok: true, detail: `пройдено ${result.pass}, нужно не меньше ${MIN_TESTS}` };

  const details = [];
  let detail;
  if (dataTouched) detail = 'тесты меняют data/journal.json';
  else if (result.timedOut) detail = `тесты не завершились за ${TEST_TIMEOUT} секунд`;
  else if (failed) detail = `пройдено ${result.pass}, упало ${result.failCount}`;
  else if (result.skipped || result.todo) detail = `пройдено ${result.pass}, пропущено ${result.skipped + result.todo}`;
  else detail = `пройдено ${result.pass}, нужно не меньше ${MIN_TESTS}`;
  const sub = result.names.slice(0, 5).map((n) => `   ✗ ${n}`);
  if (result.names.length > 5) sub.push(`   … и ещё ${result.names.length - 5}`);
  if (dataTouched) details.push('Тесты изменили data/journal.json в копии проекта, а это файл с записями пользователя.');
  let hint;
  if (dataTouched || studentGreen) hint = CLEAN_COPY_HINT;
  else if (failed) hint = 'npm test должен быть зелёным на текущем коде. Если красный только новый тест на ещё не исправленный баг, это нормальный промежуточный шаг: исправьте код и запустите проверку снова.';
  else if (result.skipped || result.todo) hint = 'пропущенный тест ничего не проверяет: уберите skip и todo.';
  else hint = `нужно не меньше ${MIN_TESTS} тестов: API, сводка и отчёт за месяц.`;
  return { ok: false, detail, details, sub, hint };
});

// 4. Мутации
async function moduleExports(dir, file) {
  const url = pathToFileURL(path.join(dir, file)).href;
  const code = `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify(Object.keys(m)));`;
  const res = await run(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: childEnv(), timeoutSec: 30 });
  if (res.status !== 0) return { ok: false, error: lastLines(res.stderr, 1)[0] ?? `код ${res.status}` };
  try {
    return { ok: true, names: JSON.parse(lastLines(res.stdout, 1)[0]) };
  } catch {
    return { ok: false, error: 'не удалось прочитать список экспортов' };
  }
}

check.criterion('Мутации', async (ctx) => {
  if (!testsGreen) return { ok: false, word: 'не проверялось, нужны зелёные тесты' };
  const exportsOf = {};
  for (const { file, name } of CONTRACT) {
    const found = existsSync(path.join(C, file)) ? await moduleExports(C, file) : { ok: false };
    if (!found.ok || !found.names.includes(name)) {
      return { ok: false, detail: 'мутации не запускались', hint: CONTRACT_HINT };
    }
    const typeCheck = await run(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(path.join(C, file)).href)}); console.log(typeof m[${JSON.stringify(name)}]);`],
    { cwd: C, env: childEnv(), timeoutSec: 30 });
    if (typeCheck.stdout.trim() !== 'function') return { ok: false, detail: 'мутации не запускались', hint: CONTRACT_HINT };
    exportsOf[file] = found.names;
  }

  const sub = [];
  let caught = 0;
  for (const [i, mutant] of MUTANTS.entries()) {
    const dir = linkedCopy(C, C);
    const target = path.join(dir, mutant.file);
    renameSync(target, path.join(path.dirname(target), origName(mutant.file)));
    writeFileSync(target, buildWrapper(mutant, exportsOf[mutant.file]));
    const probe = await moduleExports(dir, mutant.file);
    if (!probe.ok || !probe.names.includes(mutant.fn)) {
      removeTemp(dir);
      ctx.stop([`Мутация ${i + 1} не применилась. Это сбой проверки: сообщите автору набора.`, probe.error ?? ''].filter(Boolean), 3);
    }
    const result = await runTests(dir);
    removeTemp(dir);
    const label = `   4.${i + 1} ${mutant.name}`;
    if (result.failCount > 0 && !result.timedOut) {
      caught += 1;
      const example = result.names[0];
      sub.push(`${label}: поймана (упало ${result.failCount}${example ? `, например «${example}»` : ''})`);
    } else {
      sub.push(`${label}: не поймана${result.timedOut ? ` (тесты не завершились за ${TEST_TIMEOUT} секунд)` : ''}`);
      sub.push(...wrap('      Подсказка: ', mutant.hint, '      '));
    }
  }
  return { ok: caught === MUTANTS.length, word: `поймано ${caught} из ${MUTANTS.length}`, sub };
});

// 5. Express — актуальный мажор
check.criterion('Express — актуальный мажор', () => {
  if (!installed) return { ok: false, word: NOT_INSTALLED };
  const installedVersion = readJson(path.join(C, 'node_modules/express/package.json'))?.version ?? null;
  const range = readJson(path.join(C, 'package.json'))?.dependencies?.express ?? null;
  const lock = readJson(path.join(C, 'package-lock.json'));
  const lockVersion = lock?.packages?.['node_modules/express']?.version ?? lock?.dependencies?.express?.version ?? null;
  const major = (v) => (v ? Number(/^\D*(\d+)/.exec(v)?.[1]) : null);
  const rangeOk = range !== null && new RegExp(`^\\s*[\\^~]?${EXPECTED_MAJOR}(?:[.\\s]|$)`).test(range);
  const ok = major(installedVersion) === EXPECTED_MAJOR && rangeOk && major(lockVersion) === EXPECTED_MAJOR;
  if (ok) return { ok: true, detail: installedVersion };
  let hint;
  if (installedVersion === null) hint = 'express не установлен: в dependencies package.json его нет.';
  else if (major(installedVersion) < EXPECTED_MAJOR) hint = `Express всё ещё ${major(installedVersion)}.x. Обновите по руководству «Moving to Express ${EXPECTED_MAJOR}» одной зависимостью и отдельным коммитом.`;
  else if (major(installedVersion) !== EXPECTED_MAJOR) hint = `Установлен Express ${installedVersion}, а проверка ждёт мажор ${EXPECTED_MAJOR}. Сообщите автору набора.`;
  else hint = 'package.json и lock-файл расходятся: выполните установку через npm, а не правкой файла руками.';
  return { ok: false, detail: installedVersion ?? 'не установлен', hint };
});

// 6. Баг из issue 7
const ISSUE_ENTRIES = ['2026-03-12', '2026-03-13', '2026-03-14'].map((date) => ({ date, title: 'Проверка', pages: 10 }));
const ISSUE_DAYS = [['2026-03-14', 3], ['2026-03-15', 3], ['2026-03-16', 0]];

async function streaksViaServer() {
  if (!server || exited(server)) return null;
  const base = `http://127.0.0.1:${serverPort}`;
  try {
    for (const entry of ISSUE_ENTRIES) {
      const res = await request(`${base}/api/entries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
      if (res.status < 200 || res.status > 299) return null;
    }
    const streaks = [];
    for (const [today] of ISSUE_DAYS) {
      const res = await request(`${base}/api/stats?today=${today}`);
      streaks.push(JSON.parse(res.body).streak);
    }
    return streaks;
  } catch {
    return null;
  }
}

async function streaksDirect() {
  const url = pathToFileURL(path.join(C, 'src/stats.js')).href;
  const entries = ISSUE_ENTRIES.map((e, i) => ({ id: `check-${i + 1}`, ...e }));
  const code = `const { summarize } = await import(${JSON.stringify(url)});
const entries = ${JSON.stringify(entries)};
console.log(JSON.stringify(${JSON.stringify(ISSUE_DAYS.map(([d]) => d))}.map((today) => summarize(entries, today).streak)));`;
  const res = await run(process.execPath, ['--input-type=module', '-e', code], { cwd: C, env: childEnv(), timeoutSec: 30 });
  if (res.status !== 0) return { error: lastLines(res.stderr, 1)[0] ?? `код ${res.status}` };
  try {
    return { streaks: JSON.parse(lastLines(res.stdout, 1)[0]) };
  } catch {
    return { error: 'summarize не вернул серию' };
  }
}

check.criterion('Баг из issue 7', async () => {
  if (!installed) return { ok: false, word: NOT_INSTALLED };
  let streaks = await streaksViaServer();
  const viaServer = streaks !== null;
  if (!viaServer) {
    const direct = await streaksDirect();
    if (direct.error) return { ok: false, details: [`Не удалось вызвать summarize из src/stats.js: ${direct.error}`, 'Проверено без сервера.'] };
    streaks = direct.streaks;
  }
  const [s14, s15, s16] = streaks;
  const details = [];
  let word;
  if (s14 === 3 && s15 === 3 && s16 === 0) word = 'исправлен';
  else {
    if (s15 !== 3) {
      word = 'на месте';
      details.push(`Баг на месте: 15 марта серия ${s15}, ожидается 3 (docs/issue-7.md).`);
    } else word = 'нет';
    if (s14 !== 3) {
      details.push(s15 === 3
        ? `Исправление перестаралось: 14 марта, в день с записью, серия ${s14}, ожидается 3 — сегодняшняя запись входит в серию.`
        : `14 марта, в день с записью, серия ${s14}, ожидается 3.`);
    }
    if (s16 !== 0) details.push(`Исправление перестаралось: пропущенный день должен прерывать серию (16 марта серия ${s16}, ожидается 0).`);
  }
  if (!viaServer) details.push('Проверено без сервера.');
  return { ok: word === 'исправлен', word, details };
});

// 7. ADR
check.criterion('ADR об обновлении', () => {
  const adrDir = path.join(C, 'docs/adr');
  const adrs = existsSync(adrDir) ? readdirSync(adrDir).filter((f) => f.endsWith('.md')).sort() : [];
  if (!adrs.length) return { ok: false, detail: 'нет docs/adr/*.md' };
  let best = null;
  for (const file of adrs) {
    const text = readFileSync(path.join(adrDir, file), 'utf8');
    const missing = [];
    for (const section of ['Контекст', 'Решение', 'Последствия']) {
      if (!new RegExp(`^[#\\s*]*${section}`, 'm').test(text)) missing.push(`раздела «${section}»`);
    }
    if (!/express/i.test(text)) missing.push('слова Express');
    if (!/(^|\D)5(\D|$)/.test(text)) missing.push('версии 5');
    if (!missing.length) return { ok: true, detail: `docs/adr/${file}` };
    if (!best || missing.length < best.missing.length) best = { file, missing };
  }
  return { ok: false, detail: `docs/adr/${best.file}`, hint: `в ADR не хватает: ${best.missing.join(', ')}.` };
});

// 8. AGENTS.md
check.criterion('AGENTS.md с командами', () => {
  const text = readText(path.join(C, 'AGENTS.md'));
  if (text === null) return { ok: false, detail: 'файла нет' };
  const missing = [];
  if (launch) {
    if (!text.includes(launch.line)) missing.push(launch.line);
  } else if (!/\bnpm (start|run [\w:.-]+)/.test(text)) missing.push('команды запуска');
  if (!/\bnpm test\b/.test(text)) missing.push('npm test');
  if (!/\bnpm (ci|install)\b/.test(text)) missing.push('npm ci или npm install');
  if (!/JOURNAL_FILE|\.env\b/.test(text)) missing.push('JOURNAL_FILE или .env');
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > 60) note('AGENTS.md длиннее 60 строк: агент читает его в каждой сессии.');
  if (missing.length) return { ok: false, detail: `нет: ${missing.join(', ')}` };
  return { ok: true };
});

let tampered = false;
check.after(async () => {
  await stopChildren();
  server = null;
  removeTemps();
  if (before !== null && snapshot(files) !== before) tampered = true;
});

await check.run();
if (tampered) {
  console.log('Автопроверка изменила файлы проекта, сообщите автору набора.');
  process.exitCode = 3;
}
