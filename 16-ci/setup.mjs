// Разворачивает учебный проект из tracker.bundle в папку tracker.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes('--hint-check')) {
  // npm run check в папке практики ничего не проверяет, а подсказывает, где проверка.
  if (!existsSync('tracker')) console.log('Папки tracker ещё нет: сначала выполните npm run setup.');
  console.log('Автопроверка этой практики запускается в папке tracker:');
  console.log('  cd tracker');
  console.log('  npm run check');
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.log(`Нужен Node.js 22 или новее, сейчас ${process.version}. Обновите Node.js и запустите npm run setup ещё раз.`);
  process.exit(1);
}

if (existsSync('tracker')) {
  console.log('Папка tracker уже есть. Чтобы начать заново, удалите её и запустите npm run setup ещё раз.');
  process.exit(0);
}

const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitVersion.error || gitVersion.status !== 0) {
  console.log('Не найден Git. Установите Git 2.30 или новее и запустите npm run setup ещё раз.');
  process.exit(1);
}
if (!existsSync('tracker.bundle')) {
  console.log('Не найден файл tracker.bundle. Скачайте набор заново: git clone https://github.com/guidedao/vibecoding-kit');
  process.exit(1);
}

const clone = spawnSync('git', ['clone', '--quiet', '--branch', 'main', 'tracker.bundle', 'tracker'], { stdio: 'inherit' });
if (clone.status !== 0) process.exit(clone.status ?? 1);
// Ветка коллеги становится локальной: её студент пушит и открывает из неё PR.
const branch = spawnSync('git', ['-C', 'tracker', 'branch', '--quiet', '--no-track', 'counter-refactor', 'origin/counter-refactor'], { stdio: 'inherit' });
if (branch.status !== 0) process.exit(branch.status ?? 1);
// origin указывает на бандл; без него git push студента никуда не уйдёт и не запутает.
// Шаг ❷ практики создаёт origin на GitHub командой gh repo create.
spawnSync('git', ['-C', 'tracker', 'remote', 'remove', 'origin'], { stdio: 'inherit' });
console.log('Готово: учебный проект в папке 16-ci/tracker, ветки main и counter-refactor.');
console.log('Откройте её в агенте, заполните .env.local по .env.example, затем npm install и npx playwright install chromium.');
