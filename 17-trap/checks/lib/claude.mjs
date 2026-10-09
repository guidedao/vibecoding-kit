// Чтение настроек Claude Code для критерия 3. Только читает файлы.
//
// Файлы: <приманка>/.claude/settings.local.json, <приманка>/.claude/settings.json
// и пользовательский ~/.claude/settings.json (или $CLAUDE_CONFIG_DIR/settings.json).
// Списки правил объединяются, как в Claude Code: deny → ask → allow.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const READ_ENV = ['Read(./.env)', 'Read(.env)', 'Read(**/.env)', 'Read(./.env*)', 'Read(./**/.env)'];
const READ_ENV_ANY = ['Read(./.env.*)', 'Read(.env.*)', 'Read(**/.env.*)', 'Read(./.env*)', 'Read(./**/.env.*)'];
const CURL = ['Bash(curl *)', 'Bash(curl:*)'];
const WGET = ['Bash(wget *)', 'Bash(wget:*)'];
const NPM_RUN = ['Bash(npm run *)', 'Bash(npm run:*)', 'Bash(npm *)', 'Bash(npm:*)'];
const NPX = ['Bash(npx *)', 'Bash(npx:*)'];
const NODE = ['Bash(node *)', 'Bash(node:*)'];

const tilde = (p) => {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~/${path.relative(home, p).split(path.sep).join('/')}` : p;
};

export function claudeFiles(trap) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const user = path.join(configDir, 'settings.json');
  return [
    { scope: 'local', label: '.claude/settings.local.json приманки', file: path.join(trap, '.claude', 'settings.local.json') },
    { scope: 'project', label: '.claude/settings.json приманки', file: path.join(trap, '.claude', 'settings.json') },
    { scope: 'user', label: tilde(user), file: user },
  ];
}

/** Найдены ли личные настройки Claude Code (проектный файл приманки не считается). */
export function claudeFound(trap) {
  return claudeFiles(trap).some(({ scope, file }) => scope !== 'project' && existsSync(file));
}

const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string').map((v) => v.trim()) : []);
const hasAny = (rules, wanted) => rules.some((rule) => wanted.includes(rule));

/**
 * Возвращает { ok, problems, notes }.
 * problems — строки для «Что не так», notes — заметки, не влияющие на итог.
 */
export function evaluateClaude(trap) {
  const loaded = [];
  for (const entry of claudeFiles(trap)) {
    if (!existsSync(entry.file)) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(entry.file, 'utf8'));
    } catch {
      return { ok: false, problems: [`${entry.label} не читается как JSON`], notes: [] };
    }
    if (!data || typeof data !== 'object') data = {};
    loaded.push({ ...entry, data });
  }

  const perms = (entry) => (entry.data.permissions && typeof entry.data.permissions === 'object' ? entry.data.permissions : {});
  const deny = loaded.flatMap((entry) => list(perms(entry).deny));
  const ask = loaded.flatMap((entry) => list(perms(entry).ask));
  const problems = [];
  const notes = [];

  // Чтение .env
  if (!hasAny(deny, READ_ENV)) problems.push('в deny нет правила чтения .env');

  // Сеть: WebFetch и curl в deny или строгий сэндбокс без разрешённых доменов
  const webFetch = deny.some((rule) => rule === 'WebFetch' || /^WebFetch\(.*\)$/.test(rule));
  const curl = hasAny(deny, CURL);
  const firstDefined = (getter) => {
    for (const scope of ['local', 'project', 'user']) {
      const entry = loaded.find((e) => e.scope === scope);
      const value = entry ? getter(entry.data) : undefined;
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const sandboxEnabled = firstDefined((d) => d.sandbox?.enabled);
  const unsandboxed = firstDefined((d) => d.sandbox?.allowUnsandboxedCommands);
  const domains = loaded.flatMap((entry) => list(entry.data.sandbox?.network?.allowedDomains));
  const strictSandbox = sandboxEnabled === true && unsandboxed === false && domains.length === 0;
  if (!(webFetch && curl) && !strictSandbox) {
    if (!webFetch) problems.push('в deny нет WebFetch');
    if (!curl) problems.push('в deny нет правила для curl: Bash(curl *)');
  }

  // Запуск скриптов проекта
  if (!hasAny([...ask, ...deny], NPM_RUN)) problems.push('npm run не стоит на вопросе: в ask нет Bash(npm run *)');
  for (const entry of loaded.filter((e) => e.scope !== 'project')) {
    const allowed = list(perms(entry).allow).filter((rule) => NPM_RUN.includes(rule));
    for (const rule of allowed) problems.push(`${rule} стоит в allow файла ${entry.label}`);
  }

  // Режим без вопросов
  for (const entry of loaded) {
    if (perms(entry).defaultMode === 'bypassPermissions' || entry.data.defaultMode === 'bypassPermissions') {
      problems.push(`в ${entry.label} задан defaultMode: bypassPermissions — вопросы выключены`);
    }
  }

  if (!hasAny(deny, READ_ENV_ANY)) notes.push('Нет запрета на чтение .env.*.');
  if (!hasAny(deny, WGET) && !strictSandbox) notes.push('Нет запрета на wget.');
  if (!hasAny([...ask, ...deny], NPX)) notes.push('Нет правила для npx.');
  if (!hasAny([...ask, ...deny], NODE)) notes.push('Нет правила для node.');

  return { ok: problems.length === 0, problems, notes };
}
