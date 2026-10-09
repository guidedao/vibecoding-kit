// Разворачивает учебный проект «Журнал чтения» из journal.bundle в папку journal.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.dirname(fileURLToPath(import.meta.url)));

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.log(`Нужен Node.js 22 или новее, сейчас ${process.version}. Обновите Node.js и запустите npm run setup ещё раз.`);
  process.exit(1);
}

if (existsSync('journal')) {
  console.log('Папка journal уже есть. Чтобы начать заново, удалите её и запустите npm run setup ещё раз.');
  process.exit(0);
}

const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitVersion.error || gitVersion.status !== 0) {
  console.log('Не найден Git. Установите Git 2.30 или новее и запустите npm run setup ещё раз.');
  process.exit(1);
}
if (!existsSync('journal.bundle')) {
  console.log('Не найден файл journal.bundle. Скачайте набор заново: git clone https://github.com/guidedao/vibecoding-kit');
  process.exit(1);
}

const clone = spawnSync('git', ['clone', '--quiet', '--branch', 'main', 'journal.bundle', 'journal'], { stdio: 'inherit' });
if (clone.status !== 0) process.exit(clone.status ?? 1);
// origin указывает на бандл; без него git push студента никуда не уйдёт и не запутает.
spawnSync('git', ['-C', 'journal', 'remote', 'remove', 'origin'], { stdio: 'inherit' });
console.log('Готово: заброшенный проект в папке 19-legacy/journal.');
console.log('Откройте её в агенте. Автопроверка: npm run check в папке 19-legacy.');
