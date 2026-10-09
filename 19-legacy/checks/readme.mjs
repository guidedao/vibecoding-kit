// Разбор README учебного проекта для критерия 2 «Запуск по README».
//
// planReadme(text)  — раздел «Запуск»: какие строки блока команд выполнить
//                     (cp, mkdir), какой командой запустить сервер, что
//                     пропустить и о чём сказать в заметках;
// auditReadme(...)  — сверка всего README с package.json, .nvmrc и engines.
//
// Только встроенные возможности JavaScript: файлы читает run.mjs.

export const MIN_NODE = 22;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SAFE_PATH = /^(?!\/)(?!~)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.\-/@+]+$/;

/** Строки README с пометкой, внутри ли они ограждённого блока. */
function scanLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  let fence = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        result.push({ line, kind: 'fence-close' });
        fence = null;
      } else {
        result.push({ line, kind: 'code' });
      }
    } else if (m) {
      fence = m[1];
      result.push({ line, kind: 'fence-open' });
    } else {
      const h = HEADING.exec(line);
      result.push(h ? { line, kind: 'heading', level: h[1].length, title: h[2] } : { line, kind: 'text' });
    }
  }
  return result;
}

/** Строки первого ограждённого блока в разделе «Запуск» или null. */
export function launchBlock(text) {
  const lines = scanLines(text);
  const start = lines.findIndex((l) => l.kind === 'heading' && l.level <= 3 && /^Запуск/.test(l.title));
  if (start < 0) return null;
  const level = lines[start].level;
  const block = [];
  let inside = false;
  for (const l of lines.slice(start + 1)) {
    if (!inside && l.kind === 'heading' && l.level <= level) break;
    if (!inside && l.kind === 'fence-open') {
      inside = true;
      continue;
    }
    if (inside && l.kind === 'fence-close') return block;
    if (inside) block.push(l.line);
  }
  return inside ? block : null;
}

const tokens = (line) => line.trim().split(/\s+/).filter(Boolean);
const isSafePath = (arg) => SAFE_PATH.test(arg);

/**
 * План выполнения раздела «Запуск».
 * { section, steps: [{ line, cmd, args }], launch: { line, kind, script?, args } | null, notes }
 */
export function planReadme(text) {
  const block = launchBlock(text);
  const plan = { section: block !== null, steps: [], launch: null, notes: [] };
  if (!block) return plan;
  for (const raw of block) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^\$\s+/, '');
    const t = tokens(line);
    const [cmd, sub] = t;
    if (cmd === 'npm' && ['ci', 'install', 'i'].includes(sub) && t.length === 2) continue;
    if (cmd === 'nvm') continue;
    if (cmd === 'cd') {
      plan.notes.push(`Строка cd в README («${line}»): команды должны выполняться из корня проекта.`);
      continue;
    }
    if (cmd === 'cp' || cmd === 'mkdir') {
      const args = t.slice(1);
      const flags = args.filter((a) => a.startsWith('-'));
      const paths = args.filter((a) => !a.startsWith('-'));
      const flagsOk = flags.every((f) => (cmd === 'cp' ? /^-[nfpRr]+$/ : /^-p$/).test(f));
      const countOk = cmd === 'cp' ? paths.length === 2 : paths.length >= 1;
      if (flagsOk && countOk && paths.every(isSafePath)) {
        plan.steps.push({ line, cmd, args });
        continue;
      }
    }
    if (cmd === 'npm' && sub === 'start') {
      plan.launch = { line, kind: 'npm', script: 'start', args: t.slice(1) };
      continue;
    }
    if (cmd === 'npm' && (sub === 'run' || sub === 'run-script') && t[2] && !t[2].startsWith('-')) {
      plan.launch = { line, kind: 'npm', script: t[2], args: ['run', ...t.slice(2)] };
      continue;
    }
    if (cmd === 'node' && t.length >= 2 && !/[;&|<>`$]/.test(line)) {
      plan.launch = { line, kind: 'node', args: t.slice(1) };
      continue;
    }
    plan.notes.push(`Строку README проверка не выполняла: ${line}`);
  }
  return plan;
}

/** Удовлетворяет ли версия Node диапазону engines.node: true, false или null (форма не поддержана). */
export function engineAllows(range, version) {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const current = [major, minor, patch];
  const parts = String(range).trim().split(/\s*\|\|\s*/);
  let known = true;
  const results = parts.map((part) => {
    let m;
    if ((m = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part))) return cmp(current, m.slice(1, 4).map((x) => Number(x ?? 0))) >= 0;
    if ((m = /^\^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part))) return major === Number(m[1]) && cmp(current, m.slice(1, 4).map((x) => Number(x ?? 0))) >= 0;
    if ((m = /^~\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part))) {
      if (major !== Number(m[1])) return false;
      if (m[2] !== undefined && minor !== Number(m[2])) return false;
      return cmp(current, m.slice(1, 4).map((x) => Number(x ?? 0))) >= 0;
    }
    if ((m = /^v?(\d+)(?:\.[x*])?(?:\.[x*])?$/.exec(part))) return major === Number(m[1]);
    known = false;
    return false;
  });
  if (results.some(Boolean)) return true;
  return known ? false : null;
}

/**
 * Сверка README с проектом. Возвращает { findings, notes }.
 * hasTests — есть ли файлы tests/*.test.js: пока тестов нет, заглушка
 * npm test — заметка, а не провал (урок не просит чинить её на шаге ❷).
 */
export function auditReadme({ readme, pkg, nvmrc, nodeVersion, hasTests }) {
  const findings = [];
  const notes = [];
  const scripts = pkg?.scripts ?? {};
  const add = (list, text) => {
    if (!list.includes(text)) list.push(text);
  };

  if (/\bnpm start\b/.test(readme) && !scripts.start) add(findings, 'README велит npm start, а в package.json нет скрипта start.');
  for (const m of readme.matchAll(/\bnpm run(?:-script)?\s+([A-Za-z0-9:_.-]+)/g)) {
    if (!scripts[m[1]]) add(findings, `README велит npm run ${m[1]}, а в package.json нет скрипта ${m[1]}.`);
  }
  if (/\bnpm test\b/.test(readme)) {
    if (!scripts.test) add(findings, 'README велит npm test, а в package.json нет скрипта test.');
    else if (/no test specified/.test(scripts.test)) {
      const text = 'README велит npm test, а скрипт test — заглушка «no test specified».';
      if (hasTests) add(findings, text);
      else add(notes, `${text} Пока тестов нет, это заметка; появятся тесты — исправьте скрипт.`);
    }
  }
  for (const m of readme.matchAll(/\bNode(?:\.js)?\s+v?(\d+)/g)) {
    const n = Number(m[1]);
    if (n < MIN_NODE) add(findings, `README называет Node ${n}, проект требует ${MIN_NODE}+.`);
  }
  if (nvmrc !== null && nvmrc !== undefined) {
    const value = nvmrc.trim();
    const m = /^v?(\d+)/.exec(value);
    if (!m) add(notes, `.nvmrc: «${value}» — проверка не разбирает эту форму.`);
    else if (Number(m[1]) < MIN_NODE) add(findings, `.nvmrc: ${value}, нужно ${MIN_NODE} или новее.`);
  }
  const engine = pkg?.engines?.node;
  if (engine !== undefined) {
    const allows = engineAllows(engine, nodeVersion);
    const current = nodeVersion.replace(/^v/, '').split('.')[0];
    if (allows === false) add(findings, `engines.node «${engine}» не допускает текущий Node ${current}.`);
    if (allows === null) add(notes, `engines.node «${engine}»: проверка не разбирает эту форму.`);
  }
  return { findings, notes };
}
