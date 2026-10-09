// Серия дней подряд, заканчивающаяся сегодня.
export function currentStreak(dates, today) {
  const days = new Set(dates);
  let streak = 0;
  const cursor = new Date(`${today}T00:00:00Z`);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}
