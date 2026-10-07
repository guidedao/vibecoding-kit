// vibecoding-kit · общий раннер автопроверок.
//
// Источник — kit-lib/check.mjs в корне набора. В папках практик лежат точные
// копии этого файла (checks/kit-check.mjs). Копии не правьте: измените
// источник и запустите `node tools/sync-kit-lib.mjs`.
//
// Без зависимостей, Node.js 22 или новее.
//
// Пример:
//   import { createCheck } from './kit-check.mjs';
//   const check = createCheck({ heading: 'Проверка практики «Пример»' });
//   check.criterion('README.md', () => ({
//     ok: existsSync('README.md'),
//     pass: 'Есть README.md',
//     fail: 'Нет README.md',
//     hint: 'попросите агента описать проект в README.md.',
//   }));
//   await check.run();
//
// Вывод по умолчанию:
//   ✔ критерий выполнен
//   ✘ критерий не выполнен
//     Подсказка: куда смотреть.
//
//   Итог: N из M. Практика пройдена.   (или «не пройдена»)
//
// Коды выхода: 0 — все критерии пройдены, 1 — есть непройденные,
// 2 — проверку нельзя провести (например, проект не запускается).

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXIT = Object.freeze({ PASSED: 0, FAILED: 1, NOT_READY: 2 });

class StopCheck extends Error {
  constructor(lines, code) {
    super('check stopped');
    this.lines = lines;
    this.code = code;
  }
}

const toLines = (value) => {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(toLines);
  return String(value).split('\n');
};

function normalizeResult(value) {
  if (typeof value === 'boolean') return { ok: value };
  if (value && typeof value === 'object') return { ...value, ok: Boolean(value.ok) };
  return { ok: false, hint: 'критерий не вернул результат' };
}

// Текст строки: result.pass / result.fail, если заданы, иначе имя критерия.
export function defaultRenderCriterion({ ok, name, pass, fail, hint, details }) {
  const text = (ok ? pass : fail) ?? name;
  const hintLines = ok ? [] : toLines(hint);
  return [
    `${ok ? '✔' : '✘'} ${text}`,
    ...toLines(details).map((line) => `  ${line}`),
    ...hintLines.map((line, i) => `  ${i === 0 ? 'Подсказка: ' : ''}${line}`),
  ];
}

export function defaultRenderSummary({ passed, total }) {
  return ['', `Итог: ${passed} из ${total}. Практика ${passed === total ? 'пройдена' : 'не пройдена'}.`];
}

/**
 * Создаёт проверку. Шаги выполняются по порядку:
 *   before(ctx)       — подготовка; ctx.stop(lines, code) прерывает проверку;
 *   criterion(name, fn) — критерий; fn возвращает true/false
 *                       или { ok, pass, fail, hint, detail, details };
 *   after(ctx)        — уборка, выполняется всегда.
 * heading — первая строка вывода, после неё пустая строка.
 * run() печатает результат, ставит process.exitCode и возвращает код.
 */
export function createCheck({
  heading,
  renderCriterion = defaultRenderCriterion,
  renderSummary = defaultRenderSummary,
} = {}) {
  const befores = [];
  const criteria = [];
  const afters = [];
  const print = (lines) => {
    for (const line of toLines(lines)) process.stdout.write(`${line}\n`);
  };
  const ctx = {
    print,
    stop(lines, code = EXIT.NOT_READY) {
      throw new StopCheck(toLines(lines), code);
    },
  };

  const api = {
    before(fn) {
      befores.push(fn);
      return api;
    },
    criterion(name, fn) {
      criteria.push({ name, fn });
      return api;
    },
    after(fn) {
      afters.push(fn);
      return api;
    },
    async run() {
      let code = EXIT.NOT_READY;
      if (heading) print([heading, '']);
      try {
        for (const fn of befores) await fn(ctx);
        const results = [];
        for (const [i, { name, fn }] of criteria.entries()) {
          let result;
          try {
            result = normalizeResult(await fn(ctx));
          } catch (error) {
            if (error instanceof StopCheck) throw error;
            result = { ok: false, hint: `критерий не удалось проверить: ${error?.message ?? error}` };
          }
          const entry = { index: i + 1, name, ...result };
          results.push(entry);
          print(renderCriterion(entry));
        }
        const passed = results.filter((entry) => entry.ok).length;
        print(renderSummary({ passed, total: results.length, results }));
        code = passed === results.length ? EXIT.PASSED : EXIT.FAILED;
      } catch (error) {
        if (error instanceof StopCheck) {
          print(error.lines);
          code = error.code;
        } else {
          print([
            `Проверка остановилась из-за внутренней ошибки: ${error?.message ?? error}`,
            'Это ошибка набора, а не вашего проекта. Покажите этот вывод в чате курса.',
          ]);
          code = EXIT.NOT_READY;
        }
      } finally {
        for (const fn of afters) {
          try {
            await fn(ctx);
          } catch {
            // уборка не должна менять итог проверки
          }
        }
      }
      process.exitCode = code;
      return code;
    },
  };
  return api;
}

/** Копирует проект во временную папку, без .git и node_modules. */
export function copyProject(source, { exclude = ['.git', 'node_modules'], prefix = 'vibecoding-kit-' } = {}) {
  const root = path.resolve(source);
  const target = mkdtempSync(path.join(os.tmpdir(), prefix));
  cpSync(root, target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      return !rel || !rel.split(path.sep).some((part) => exclude.includes(part));
    },
  });
  return target;
}

export function removeDir(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

const lastNumber = (text, key) => {
  let value = null;
  for (const match of text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))) value = Number(match[1]);
  return value;
};

/**
 * Разбирает TAP-вывод `node --test --test-reporter=tap`.
 * Строки `not ok`, где имя оканчивается на .js, — это файлы, которые не
 * запустились (или обёртки файлов в некоторых версиях Node); они идут
 * в failedFiles, а не в failed.
 */
export function parseTap(text, { cwd } = {}) {
  const failed = [];
  const failedFiles = [];
  let base = null;
  if (cwd) {
    try {
      base = realpathSync(cwd);
    } catch {
      base = path.resolve(cwd);
    }
  }
  for (const match of text.matchAll(/^\s*not ok \d+ - (.*)$/gm)) {
    const name = match[1]
      .replace(/\s+#\s+(SKIP|TODO)\b.*$/i, '')
      .replace(/\\#/g, '#')
      .replace(/\\\\/g, '\\')
      .trim();
    if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) {
      let file = name;
      if (base && path.isAbsolute(name)) {
        let real = name;
        try {
          real = realpathSync(name);
        } catch {
          // файла может уже не быть
        }
        const rel = path.relative(base, real);
        if (!rel.startsWith('..')) file = rel.split(path.sep).join('/');
      }
      if (!failedFiles.includes(file)) failedFiles.push(file);
    } else if (!failed.includes(name)) {
      failed.push(name);
    }
  }
  const pass = lastNumber(text, 'pass');
  const fail = lastNumber(text, 'fail');
  const cancelled = lastNumber(text, 'cancelled') ?? 0;
  const failCount = (fail ?? 0) + cancelled;
  const tests = lastNumber(text, 'tests') ?? (pass ?? 0) + failCount;
  return { tests, pass: pass ?? 0, fail: fail ?? 0, cancelled, failCount, failed, failedFiles, hasSummary: pass !== null };
}

/**
 * Запускает тесты node:test в папке cwd тем же Node, что и проверку.
 * Возвращает { ok, timedOut, status, tests, pass, failCount, failed, failedFiles, output }.
 */
export function runNodeTests({ cwd, files, timeoutMs = 60_000 }) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const output = `${stdout}${result.stderr ?? ''}`;
  const timedOut = result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal != null);
  const tap = parseTap(stdout, { cwd });
  const ok = !timedOut && !result.error && result.status === 0 && tap.hasSummary && tap.failCount === 0;
  return { ok, timedOut, status: result.status, error: result.error, ...tap, output };
}

/**
 * Запускает git в папке cwd. Возвращает { ok, status, out, err }; out без
 * перевода строки в конце. Ничего не бросает: отсутствие Git — ok: false.
 */
export function git(cwd, args, { env } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    out: (result.stdout ?? '').replace(/\n$/, ''),
    err: result.error?.message ?? result.stderr ?? '',
  };
}
