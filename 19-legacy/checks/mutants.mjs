// Три мутации для критерия 4. Каждая вносится на границе модуля: целевой
// файл в копии проекта переименовывается в <имя>.__orig.js, на его месте
// пишется обёртка, которая реэкспортирует все прочие имена оригинала и
// подменяет одну функцию. Поэтому мутации переживают любой рефакторинг
// внутри src/stats.js и src/entries.js, пока сохранён контракт:
//   src/stats.js   экспортирует summarize(entries, today) → { pages, pagesThisMonth, streak, … }
//   src/entries.js экспортирует normalizeEntry(input)

export const CONTRACT = [
  { file: 'src/stats.js', name: 'summarize' },
  { file: 'src/entries.js', name: 'normalizeEntry' },
];

export const CONTRACT_HINT =
  'Мутации вносятся через summarize в src/stats.js и normalizeEntry в src/entries.js. Верните эти имена или реэкспортируйте их из этих файлов.';

export const MUTANTS = [
  {
    name: 'Страницы за месяц считаются за всё время',
    file: 'src/stats.js',
    fn: 'summarize',
    body: `export function summarize(entries, today) {
  const result = orig.summarize(entries, today);
  return { ...result, pagesThisMonth: result.pages };
}`,
    hint: 'Нужен тест сводки с записями из двух месяцев: 2026-02-28 — 40 страниц, 2026-03-01 — 10, today=2026-03-15. Ожидается pagesThisMonth 10 при pages 50.',
  },
  {
    name: 'Пустое название принимается',
    file: 'src/entries.js',
    fn: 'normalizeEntry',
    body: `export function normalizeEntry(input) {
  const title = String(input?.title ?? '').trim();
  if (title) return orig.normalizeEntry(input);
  const entry = orig.normalizeEntry({ ...input, title: 'Без названия' });
  return { ...entry, title: '' };
}`,
    hint: 'Нужен тест: POST /api/entries с названием из пробелов, страницами 10 и верной датой → 400, и в GET /api/entries запись не появилась. Если в том же запросе неверны страницы, ошибка случится и без проверки названия.',
  },
  {
    name: 'Серия снова обнуляется утром',
    file: 'src/stats.js',
    fn: 'summarize',
    body: `export function summarize(entries, today) {
  const result = orig.summarize(entries, today);
  const hasToday = Array.isArray(entries)
    && entries.some((e) => e && e.date === today);
  return hasToday ? result : { ...result, streak: 0 };
}`,
    hint: 'Нужен регрессионный тест issue 7: записи за 2026-03-12, 13 и 14, today=2026-03-15 → серия 3. Если баг ещё не исправлен, эта мутация совпадает с текущим поведением.',
  },
];

const IDENT = /^[A-Za-z_$][\w$]*$/;
const exportName = (name) => (IDENT.test(name) ? name : JSON.stringify(name));

export function origName(file) {
  const base = file.split('/').pop();
  return base.replace(/\.(m?js)$/, '.__orig.$1');
}

/** Текст обёртки: явный реэкспорт прочих имён оригинала и подменённая функция. */
export function buildWrapper(mutant, exportedNames) {
  const orig = `./${origName(mutant.file)}`;
  const others = exportedNames.filter((n) => n !== mutant.fn).map(exportName);
  return [
    '// Мутация автопроверки 19-legacy. Файл существует только во временной копии.',
    `import * as orig from '${orig}';`,
    others.length ? `export { ${others.join(', ')} } from '${orig}';` : '',
    mutant.body,
    '',
  ].join('\n');
}
