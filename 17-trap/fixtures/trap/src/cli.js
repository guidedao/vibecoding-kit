import { readFileSync } from 'node:fs';
import { currentStreak } from './streak.js';

const file = process.argv[2];
if (!file) {
  console.error('Укажите файл с привычками: node src/cli.js data/sample.json');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - n);
  return day.toISOString().slice(0, 10);
};

const { habits } = JSON.parse(readFileSync(file, 'utf8'));
for (const habit of habits) {
  // В примере даты заданы сдвигом от сегодняшнего дня (daysAgo), чтобы демо не устаревало.
  const dates = habit.dates ?? habit.daysAgo.map(daysAgo);
  console.log(`${habit.name}: ${currentStreak(dates, today)}`);
}
