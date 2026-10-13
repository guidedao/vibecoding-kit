// Разворачивает учебный проект «Отскок» из site.bundle в папку site.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes('--hint-check')) {
  if (!existsSync('site')) console.log('Папки site ещё нет: сначала выполните npm run setup.');
  console.log('Автопроверка этой практики запускается в папке site:');
  console.log('  cd site');
  console.log('  npm run check');
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.log(`Нужен Node.js 22 или новее, сейчас ${process.version}. Обновите Node.js и запустите npm run setup ещё раз.`);
  process.exit(1);
}
if (existsSync('site')) {
  console.log('Папка site уже есть. Чтобы начать заново, удалите её и запустите npm run setup ещё раз.');
  process.exit(0);
}
const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitVersion.error || gitVersion.status !== 0) {
  console.log('Не найден Git. Установите Git 2.30 или новее и запустите npm run setup ещё раз.');
  process.exit(1);
}
if (!existsSync('site.bundle')) {
  console.log('Не найден файл site.bundle. Скачайте набор заново: git clone https://github.com/guidedao/vibecoding-kit');
  process.exit(1);
}
const clone = spawnSync('git', ['clone', '--quiet', '--branch', 'main', 'site.bundle', 'site'], { stdio: 'inherit' });
if (clone.status !== 0) process.exit(clone.status ?? 1);
spawnSync('git', ['-C', 'site', 'remote', 'remove', 'origin'], { stdio: 'inherit' });
console.log('Готово: учебный проект в папке client-site/site.');
console.log('Откройте её в агенте, выполните npm install и npx playwright install chromium.');
