// Чтение настроек Codex для критерия 3. Только читает файлы.
//
// Файлы: ~/.codex/config.toml и ~/.codex/rules/*.rules (или $CODEX_HOME).
// config.toml разбирается мини-парсером TOML: таблицы, ключи, строки, числа,
// булевы значения, массивы и встроенные таблицы. Решение для команды берётся
// из `codex execpolicy check`, если codex установлен, иначе — из текста
// prefix_rule(...) по тем же правилам: forbidden > prompt > allow.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_DENY = ['.env', '**/.env', '**/*.env'];
const STRICTNESS = { allow: 0, prompt: 1, forbidden: 2 };
const BUILTIN_PROFILES = [':read-only', ':workspace', ':danger-full-access'];

const tilde = (p) => {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~/${path.relative(home, p).split(path.sep).join('/')}` : p;
};

export function codexPaths() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const config = path.join(home, 'config.toml');
  const rulesDir = path.join(home, 'rules');
  let rules = [];
  try {
    rules = readdirSync(rulesDir).filter((name) => name.endsWith('.rules')).sort().map((name) => path.join(rulesDir, name));
  } catch {
    // папки rules нет
  }
  return { home, config, rules, configLabel: tilde(config), rulesLabel: `${tilde(rulesDir)}/*.rules` };
}

export function codexFound() {
  const { config, rules } = codexPaths();
  return existsSync(config) || rules.length > 0;
}

// ---------- мини-парсер TOML

class TomlError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

export function parseToml(text) {
  const s = text.replace(/^\uFEFF/, '');
  let i = 0;
  const root = {};
  let table = root;
  const line = () => s.slice(0, i).split('\n').length;
  const error = (message) => {
    throw new TomlError(message, line());
  };
  const peek = (n = 0) => s[i + n];
  const startsWith = (str) => s.startsWith(str, i);
  const skipWs = () => {
    while (peek() === ' ' || peek() === '\t') i += 1;
  };
  const skipComment = () => {
    if (peek() === '#') while (i < s.length && peek() !== '\n') i += 1;
  };
  const skipWsNl = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (peek() === '\r' || peek() === '\n') i += 1;
      else break;
    }
  };
  const unescape = (raw) => {
    try {
      return JSON.parse(`"${raw.replace(/\\U([0-9A-Fa-f]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)).replace(/["\\]/g, '\\$&')).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`);
    } catch {
      return raw;
    }
  };
  const basicString = () => {
    i += 1;
    let raw = '';
    while (i < s.length && peek() !== '"') {
      if (peek() === '\n') error('строка не закрыта');
      if (peek() === '\\') {
        raw += s.slice(i, i + 2);
        i += 2;
      } else {
        raw += peek();
        i += 1;
      }
    }
    if (peek() !== '"') error('строка не закрыта');
    i += 1;
    return unescape(raw);
  };
  const literalString = () => {
    const end = s.indexOf("'", i + 1);
    const nl = s.indexOf('\n', i + 1);
    if (end < 0 || (nl >= 0 && nl < end)) error('строка не закрыта');
    const value = s.slice(i + 1, end);
    i = end + 1;
    return value;
  };
  const multiline = (quote) => {
    i += 3;
    if (peek() === '\r') i += 1;
    if (peek() === '\n') i += 1;
    const end = s.indexOf(quote, i);
    if (end < 0) error('многострочная строка не закрыта');
    let close = end + 3;
    while (s[close] === quote[0] && close - end < 5) close += 1;
    const raw = s.slice(i, close - 3);
    i = close;
    return quote === '"""' ? unescape(raw.replace(/\\\r?\n\s*/g, '')) : raw;
  };
  const key = () => {
    skipWs();
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i, i + 200));
    if (!m) error('ожидался ключ');
    i += m[0].length;
    return m[0];
  };
  const keyPath = () => {
    const keys = [key()];
    for (;;) {
      skipWs();
      if (peek() !== '.') break;
      i += 1;
      keys.push(key());
    }
    return keys;
  };
  const value = () => {
    skipWs();
    if (startsWith('"""')) return multiline('"""');
    if (startsWith("'''")) return multiline("'''");
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    if (peek() === '[') {
      i += 1;
      const arr = [];
      for (;;) {
        skipWsNl();
        if (peek() === ']') {
          i += 1;
          return arr;
        }
        arr.push(value());
        skipWsNl();
        if (peek() === ',') i += 1;
        else if (peek() === ']') {
          i += 1;
          return arr;
        } else error('ожидалась запятая или ] в массиве');
      }
    }
    if (peek() === '{') {
      i += 1;
      const obj = {};
      skipWs();
      if (peek() === '}') {
        i += 1;
        return obj;
      }
      for (;;) {
        const keys = keyPath();
        skipWs();
        if (peek() !== '=') error('ожидался знак =');
        i += 1;
        assign(obj, keys, value());
        skipWs();
        if (peek() === ',') i += 1;
        else if (peek() === '}') {
          i += 1;
          return obj;
        } else error('ожидалась запятая или } во встроенной таблице');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(i, i + 200));
    if (!m) error('ожидалось значение');
    i += m[0].length;
    const token = m[0];
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(token)) return Number(token.replace(/_/g, ''));
    // даты, inf, nan и прочее — как текст
    return token;
  };
  const descend = (obj, keys) => {
    let cur = obj;
    for (const k of keys) {
      if (Array.isArray(cur[k])) cur = cur[k][cur[k].length - 1];
      else {
        if (cur[k] === undefined || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
      }
    }
    return cur;
  };
  const assign = (obj, keys, val) => {
    descend(obj, keys.slice(0, -1))[keys[keys.length - 1]] = val;
  };

  for (;;) {
    skipWsNl();
    if (i >= s.length) break;
    if (startsWith('[[')) {
      i += 2;
      const keys = keyPath();
      skipWs();
      if (!startsWith(']]')) error('ожидалось ]]');
      i += 2;
      const parent = descend(root, keys.slice(0, -1));
      const last = keys[keys.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      table = {};
      parent[last].push(table);
    } else if (peek() === '[') {
      i += 1;
      const keys = keyPath();
      skipWs();
      if (peek() !== ']') error('ожидалось ]');
      i += 1;
      table = descend(root, keys);
    } else {
      const keys = keyPath();
      skipWs();
      if (peek() !== '=') error('ожидался знак =');
      i += 1;
      assign(table, keys, value());
    }
    skipWs();
    skipComment();
    if (i < s.length && peek() !== '\n' && peek() !== '\r') error('лишний текст в конце строки');
  }
  return root;
}

// ---------- rules

function stripStarlarkComments(text) {
  return text
    .split('\n')
    .map((lineText) => {
      let quote = null;
      for (let k = 0; k < lineText.length; k += 1) {
        const c = lineText[k];
        if (quote) {
          if (c === '\\') k += 1;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '#') return lineText.slice(0, k);
      }
      return lineText;
    })
    .join('\n');
}

function bracketAt(text, start) {
  let depth = 0;
  let quote = null;
  for (let k = start; k < text.length; k += 1) {
    const c = text[k];
    if (quote) {
      if (c === '\\') k += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, k + 1);
    }
  }
  return null;
}

/** Решение по тексту prefix_rule(...): 'allow' | 'prompt' | 'forbidden' | null (нет совпадений). */
export function decideFromText(texts, argv) {
  let best = null;
  for (const text of texts) {
    const clean = stripStarlarkComments(text);
    for (const chunk of clean.split(/\bprefix_rule\s*\(/).slice(1)) {
      const at = /\bpattern\s*=\s*\[/.exec(chunk);
      if (!at) continue;
      const literal = bracketAt(chunk, at.index + at[0].length - 1);
      if (!literal) continue;
      let pattern;
      try {
        pattern = JSON.parse(literal.replace(/'([^'\\]*)'/g, '"$1"').replace(/,\s*]/g, ']'));
      } catch {
        continue;
      }
      if (!Array.isArray(pattern) || pattern.length === 0 || pattern.length > argv.length) continue;
      const matches = pattern.every((part, k) => (Array.isArray(part) ? part.includes(argv[k]) : part === argv[k]));
      if (!matches) continue;
      const decision = /\bdecision\s*=\s*["'](\w+)["']/.exec(chunk)?.[1] ?? 'allow';
      if (STRICTNESS[decision] === undefined) continue;
      if (best === null || STRICTNESS[decision] > STRICTNESS[best]) best = decision;
    }
  }
  return best;
}

/**
 * Решение через `codex execpolicy check`. Возвращает
 * { available: false } — codex не найден или ответ не JSON;
 * { available: true, error } — codex не разобрал файл;
 * { available: true, decision } — 'allow' | 'prompt' | 'forbidden' | null.
 */
export function decideWithCodex(rulesFiles, argv) {
  const args = ['execpolicy', 'check'];
  for (const file of rulesFiles) args.push('--rules', file);
  args.push('--', ...argv);
  const result = spawnSync('codex', args, { encoding: 'utf8', timeout: 20_000 });
  if (result.error) return { available: false };
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').split('\n').map((l) => l.trim()).find((l) => /error/i.test(l)) ?? `код ${result.status}`;
    return { available: true, error: message };
  }
  const jsonLine = (result.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  try {
    const data = JSON.parse(jsonLine);
    return { available: true, decision: data.decision ?? null };
  } catch {
    return { available: false };
  }
}

// ---------- критерий

const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function findKey(obj, name, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === name) return true;
    if (findKey(v, name, depth + 1)) return true;
  }
  return false;
}

/** Возвращает { ok, problems, notes }. */
export function evaluateCodex(trap) {
  const { config, rules, configLabel, rulesLabel } = codexPaths();
  const problems = [];
  const notes = [];
  const realTrap = realOrSelf(trap);

  let data = {};
  if (existsSync(config)) {
    try {
      data = parseToml(readFileSync(config, 'utf8'));
    } catch (error) {
      const where = error instanceof TomlError ? ` (строка ${error.line})` : '';
      return { ok: false, problems: [`${configLabel} не читается как TOML${where}`], notes };
    }
  } else {
    problems.push(`нет ${configLabel}`);
  }

  // Недоверенный проект
  const projects = data.projects && typeof data.projects === 'object' ? data.projects : {};
  const entry = Object.entries(projects).find(([p]) => realOrSelf(expandHome(p)) === realTrap)?.[1];
  if (!entry || entry.trust_level !== 'untrusted') {
    problems.push(`нет [projects."${realTrap}"] с trust_level = "untrusted"`);
  }
  const policies = [data.approval_policy];
  if (typeof data.profile === 'string') policies.push(data.profiles?.[data.profile]?.approval_policy);
  for (const policy of policies) {
    if (policy === 'never' || policy === 'on-request') {
      problems.push(`approval_policy = "${policy}" отменяет вопросы для недоверенного проекта: уберите его`);
    } else if (policy === 'untrusted') {
      problems.push('approval_policy = "untrusted" выведен из обращения: уберите его');
    }
  }

  // Профиль прав
  const profiles = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
  const name = data.default_permissions;
  let chain = [];
  if (typeof name !== 'string') {
    problems.push('не задан default_permissions: профиль прав с запретом .env не выбран');
  } else if (BUILTIN_PROFILES.includes(name)) {
    problems.push(`default_permissions = "${name}": во встроенном профиле нет запрета .env`);
  } else if (!profiles[name]) {
    problems.push(`профиль ${name} из default_permissions не найден в [permissions]`);
  } else {
    for (let current = name; current && profiles[current] && !chain.includes(profiles[current]) && chain.length < 10; current = profiles[current].extends) {
      chain.push(profiles[current]);
    }
    const roots = chain.map((p) => p.filesystem?.[':workspace_roots'] ?? {});
    if (!roots.some((r) => ENV_DENY.some((k) => r[k] === 'deny'))) {
      problems.push(`в профиле ${name} нет "**/.env" = "deny" в filesystem.":workspace_roots"`);
    }
    if (!roots.some((r) => r['**/.env.*'] === 'deny')) notes.push('Нет запрета на чтение .env.*.');
    const network = chain.map((p) => p.network?.enabled).find((v) => v !== undefined);
    if (network === true) problems.push(`network.enabled = true в профиле ${name}: команды выходят в сеть`);
  }
  if (findKey(data, 'sandbox_mode')) problems.push('в config.toml есть sandbox_mode: с ним Codex не применяет профиль прав');

  // Rules
  const decide = (argv) => {
    const viaCodex = decideWithCodex(rules, argv);
    if (viaCodex.available) return viaCodex;
    return { decision: decideFromText(rules.map((file) => readFileSync(file, 'utf8')), argv) };
  };
  if (rules.length === 0) {
    problems.push(`нет ${rulesLabel} с правилом для npm run`);
  } else {
    const npm = decide(['npm', 'run', 'setup-cache']);
    if (npm.error) {
      problems.push(`codex execpolicy check не разбирает ${rulesLabel}: ${npm.error}`);
    } else {
      if (npm.decision !== 'prompt' && npm.decision !== 'forbidden') {
        problems.push('npm run не стоит на вопросе: нет prefix_rule с decision = "prompt" для npm run');
      }
      const askOrBlock = (d) => d === 'prompt' || d === 'forbidden';
      if (!askOrBlock(decide(['npx', 'kit17-check']).decision)) notes.push('Нет правила для npx.');
      if (!askOrBlock(decide(['node', 'kit17-check.js']).decision)) notes.push('Нет правила для node.');
      if (!askOrBlock(decide(['curl', 'kit17-check']).decision)) notes.push('Нет запрета на curl.');
      if (!askOrBlock(decide(['wget', 'kit17-check']).decision)) notes.push('Нет запрета на wget.');
    }
  }

  return { ok: problems.length === 0, problems, notes };
}
