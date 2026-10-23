// Автопроверка практики 23-usage-logs «Расход по журналам».
//
// Запускает ../usage.mjs на журналах из ../logs и на двух других наборах
// из data/ и сверяет числа с ожидаемыми. Ожидаемые числа хранятся как хеши
// (expected.json), поэтому ответы из этой папки не прочитать. Журналы
// не меняются.
//
// Коды выхода: 0 — все критерии пройдены, 1 — хотя бы один не пройден,
// 2 — проверку нельзя провести (нет usage.mjs, старый Node).
//
// Только встроенные модули Node.js 22+.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheck } from './kit-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRACTICE = path.resolve(HERE, '..');
const SCRIPT = path.join(PRACTICE, 'usage.mjs');
const EXPECTED = JSON.parse(readFileSync(path.join(HERE, 'expected.json'), 'utf8'));
const SETS = {
  logs: path.join(PRACTICE, 'logs'),
  a: path.join(HERE, 'data', 'a'),
  b: path.join(HERE, 'data', 'b'),
};
const FIELDS = {
  claude: ['responses', 'input', 'cacheWrite', 'cacheRead', 'output'],
  codex: ['sessions', 'input', 'cachedInput', 'output', 'total'],
};
// Фразы из реплик, ответов, рассуждений и вызовов тулов в журналах: в выводе их быть не должно.
const PRIVATE_TEXT = [
  'удаление привычки', 'счётчик показывает', 'отметок в CSV', 'пропуском дня', 'ставится на вчера', 'двойным щелчком',
  'расписанием кортов', 'Форма заявки', 'шириной 390', 'Поиск по заметкам', 'Сохраняй черновик', 'Корзина теряет', 'фильтр по цене',
  'откуда счётчик', 'границе недели', 'начну с теста', 'старые записи', 'Читаю src', 'Нашёл причину', 'падает, как и ожидалось',
  'Тесты проходят', 'Готово. Изменены', 'Проверил в браузере', 'Найди все места', 'Ищу вызовы', 'Проверяю src',
  'не сохраняется отметка', 'тёмную тему', 'Обнови зависимости', 'Reading the storage', 'Checking the failing', 'Planning the change',
  'ключе localStorage', 'тема следует', 'src/habits.js', 'getHabits', 'countHabits', 'npm test', '/Users/student/',
];
const TIMEOUT_MS = 60_000;

const fieldHash = (set, block, field, value) =>
  createHash('sha256').update(`vibecoding-kit-23:${set}:${block}.${field}:${value}`).digest('hex');

const HINTS = {
  'claude.responses': 'один ответ модели записан в журнале несколькими строками с одинаковыми message.id и requestId. Считайте каждую пару один раз по всем файлам, включая папки subagents.',
  'claude.output': 'в журналах субагентов output_tokens растёт от строки к строке одного ответа: берите строку с наибольшим значением.',
  claudeTokens: 'складывайте usage каждого ответа модели один раз: вход input_tokens, запись cache_creation_input_tokens, чтение cache_read_input_tokens, выход output_tokens.',
  'codex.sessions': 'одна сессия Codex — один файл rollout-*.jsonl в папке sessions и её подпапках.',
  codexTokens: 'total_token_usage в событиях token_count — итог с начала сессии. Берите последнее такое событие в каждом файле и складывайте по сессиям.',
};

const runs = {};
function runOn(set) {
  if (runs[set]) return runs[set];
  const root = SETS[set];
  const res = spawnSync(process.execPath, [SCRIPT, '--claude', path.join(root, 'claude', 'projects'), '--codex', path.join(root, 'codex', 'sessions')], {
    cwd: PRACTICE, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  });
  const out = res.stdout ?? '';
  let json = null;
  let problem = null;
  if (res.error?.code === 'ETIMEDOUT') problem = `скрипт не закончил работу за ${TIMEOUT_MS / 1000} с`;
  else if (res.status !== 0) problem = `скрипт завершился с кодом ${res.status}: ${(res.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''}`;
  else {
    try {
      json = JSON.parse(out);
    } catch {
      problem = 'вывод скрипта не разбирается как JSON';
    }
  }
  runs[set] = { out, json, problem };
  return runs[set];
}

function wrongFields(set, blocks) {
  const { json } = runOn(set);
  const wrong = [];
  for (const block of blocks) {
    for (const field of FIELDS[block]) {
      const value = json?.[block]?.[field];
      if (typeof value !== 'number' || fieldHash(set, block, field, value) !== EXPECTED[set][`${block}.${field}`]) wrong.push(`${block}.${field}`);
    }
  }
  return wrong;
}

function hintFor(wrong) {
  const hints = new Set();
  for (const key of wrong) {
    if (HINTS[key]) hints.add(HINTS[key]);
    else if (key.startsWith('claude.')) hints.add(HINTS.claudeTokens);
    else if (key.startsWith('codex.')) hints.add(HINTS.codexTokens);
  }
  return [...hints];
}

function compare(set, blocks, label) {
  const { problem } = runOn(set);
  if (problem) {
    return {
      ok: false,
      fail: `${label}: ${problem}`,
      hint: set === 'b'
        ? 'в настоящих журналах бывают пустые файлы и недописанная последняя строка. Пропускайте строки, которые не разбираются как JSON.'
        : 'запустите скрипт сами той же командой и прочитайте ошибку.',
    };
  }
  const wrong = wrongFields(set, blocks);
  return {
    ok: wrong.length === 0,
    pass: `${label}: числа сходятся`,
    fail: `${label}: не сходятся ${wrong.join(', ')}`,
    hint: hintFor(wrong),
  };
}

const check = createCheck({ heading: 'Проверка практики «Расход по журналам»' });

check.before((ctx) => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) ctx.stop([`Нужен Node.js 22 или новее, сейчас ${process.versions.node}.`]);
  if (!existsSync(SCRIPT)) {
    ctx.stop([
      'В папке 23-usage-logs нет usage.mjs.',
      'Попросите агента написать скрипт по README: node usage.mjs --claude <папка> --codex <папка>.',
    ]);
  }
});

check.criterion('usage.mjs запускается и печатает JSON', () => {
  const { problem, json } = runOn('logs');
  if (problem) return { ok: false, fail: `usage.mjs на журналах logs: ${problem}`, hint: 'команда: node usage.mjs --claude logs/claude/projects --codex logs/codex/sessions' };
  const missing = Object.entries(FIELDS).flatMap(([block, fields]) => fields.filter((f) => typeof json?.[block]?.[f] !== 'number').map((f) => `${block}.${f}`));
  return {
    ok: missing.length === 0,
    pass: 'usage.mjs запускается и печатает JSON с нужными полями',
    fail: `в выводе нет числовых полей: ${missing.join(', ')}`,
    hint: 'поля описаны в README: claude.responses, input, cacheWrite, cacheRead, output; codex.sessions, input, cachedInput, output, total.',
  };
});

check.criterion('Журналы Claude Code в logs', () => compare('logs', ['claude'], 'Claude Code в logs'));
check.criterion('Журналы Codex в logs', () => compare('logs', ['codex'], 'Codex в logs'));
check.criterion('Набор data/a', () => compare('a', ['claude', 'codex'], 'набор data/a'));
check.criterion('Набор data/b', () => compare('b', ['claude', 'codex'], 'набор data/b'));

check.criterion('Вывод без текста сообщений и путей', () => {
  const found = Object.keys(SETS).flatMap((set) => PRIVATE_TEXT.filter((text) => runOn(set).out.includes(text)));
  return {
    ok: found.length === 0,
    pass: 'в выводе только числа и названия, без текста сообщений и путей к файлам',
    fail: `в выводе есть текст из журналов: ${[...new Set(found)].join(', ')}`,
    hint: 'журналы хранят ваши сообщения и содержимое файлов. Скрипт должен печатать только посчитанные числа.',
  };
});

await check.run();
