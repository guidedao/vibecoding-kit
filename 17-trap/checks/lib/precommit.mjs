// Прогон хука pre-commit трекера для критерия 4.
//
// Три прогона: файл kit17-check-<случайное>.txt в корне трекера, git add -f,
// git hook run pre-commit. Коммиты не создаются. После каждого прогона и по
// Ctrl+C файл убирается из индекса и удаляется. Вывод хука не печатается:
// из него берётся только RuleID.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { accessSync, constants, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HOOK_TIMEOUT_MS = 120_000;
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const GIT_ENV = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1' };

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  return { ok: !result.error && result.status === 0, status: result.status, out: (result.stdout ?? '').trim() };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const ruleIds = (text) => [...new Set([...stripAnsi(text).matchAll(/RuleID:\s*(\S+)/g)].map((m) => m[1]))];

// Строка формата токена GitHub собирается во время выполнения и нигде не хранится.
function githubLikeToken() {
  let token = 'gh' + 'p_';
  for (let k = 0; k < 36; k += 1) token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return token;
}

export function hookPath(root) {
  const rel = git(root, ['rev-parse', '--git-path', 'hooks/pre-commit']);
  return rel.ok ? path.resolve(root, rel.out) : null;
}

export function gitleaksInstalled() {
  const result = spawnSync('gitleaks', ['version'], { encoding: 'utf8', timeout: 20_000 });
  return !result.error && result.status === 0;
}

/**
 * Прогоняет хук. Возвращает { ok, problems, created, leftovers, interrupted? }.
 * По SIGINT/SIGTERM/SIGHUP хук останавливается, файлы убираются,
 * затем вызывается onInterrupt(result) с result.interrupted = имя сигнала.
 */
export async function checkPrecommit(root, { onInterrupt } = {}) {
  const result = { ok: false, problems: [], created: 0, leftovers: [] };
  const hook = hookPath(root);
  if (!hook || !existsSync(hook) || !statSync(hook).isFile()) {
    result.problems.push('Хук не найден');
    return result;
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(hook, constants.X_OK);
    } catch {
      result.problems.push(`Хук ${path.relative(root, hook) || hook} не исполняемый: chmod +x`);
      return result;
    }
  }
  if (!gitleaksInstalled()) {
    result.problems.push('gitleaks не установлен');
    return result;
  }

  const active = new Set();
  let child = null;

  const cleanupOne = (name) => {
    const full = path.join(root, name);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rm = git(root, ['rm', '--cached', '--quiet', '--force', '--ignore-unmatch', '--', name]);
      if (rm.ok) break;
      sleepSync(100); // индекс может быть ещё занят прерванным хуком
    }
    rmSync(full, { force: true });
    const staged = git(root, ['ls-files', '--', name]).out !== '';
    if (staged || existsSync(full)) result.leftovers.push(name);
    active.delete(name);
  };
  const killChild = (signal) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // процесс уже завершился
    }
  };

  // Сигнал только останавливает хук; уборку делает основной цикл ниже.
  let interrupted = null;
  const onSignal = (signal) => {
    interrupted ??= signal;
    killChild('SIGTERM');
    setTimeout(() => killChild('SIGKILL'), 5_000).unref();
  };
  const handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM'), SIGHUP: () => onSignal('SIGHUP') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);

  const runHook = () =>
    new Promise((resolve) => {
      let output = '';
      child = spawn('git', ['hook', 'run', 'pre-commit'], {
        cwd: root,
        env: { ...process.env, ...GIT_ENV },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const timer = setTimeout(() => {
        killChild('SIGKILL');
        resolve({ status: null, timedOut: true, output });
      }, HOOK_TIMEOUT_MS);
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ status: null, error: true, output });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, output });
      });
    });

  const cases = [
    { id: 'А', content: 'API_KEY=FAKE-KEY-NOT-REAL', expectBlocked: true, problem: 'Коммит с FAKE-KEY-NOT-REAL прошёл: нет правила в .gitleaks.toml' },
    { id: 'Б', content: `GITHUB_TOKEN=${githubLikeToken()}`, expectBlocked: true, problem: 'Встроенные правила выключены: нет [extend] useDefault = true' },
    { id: 'В', content: 'hello', expectBlocked: false, problem: 'Хук останавливает и чистый коммит' },
  ];

  try {
    for (const testCase of cases) {
      if (interrupted) break;
      let name;
      do name = `kit17-check-${randomBytes(4).toString('hex')}.txt`;
      while (existsSync(path.join(root, name)));
      active.add(name);
      result.created += 1;
      let run;
      try {
        writeFileSync(path.join(root, name), `${testCase.content}\n`);
        const add = git(root, ['add', '--force', '--', name]);
        if (!add.ok) throw new Error(`git add ${name} не выполнился`);
        run = await runHook();
      } finally {
        child = null;
        cleanupOne(name);
      }
      if (interrupted) break;
      if (run.timedOut) {
        result.problems.push(`Хук не завершился за ${HOOK_TIMEOUT_MS / 1000} секунд (случай ${testCase.id})`);
        continue;
      }
      const blocked = run.status !== 0;
      if (blocked !== testCase.expectBlocked) {
        const rules = ruleIds(run.output);
        result.problems.push(rules.length && !testCase.expectBlocked ? `${testCase.problem} (RuleID: ${rules.join(', ')})` : testCase.problem);
      }
    }
  } finally {
    for (const name of [...active]) cleanupOne(name);
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
  if (interrupted) {
    result.interrupted = interrupted;
    onInterrupt?.(result);
    return result;
  }
  result.ok = result.problems.length === 0;
  return result;
}
