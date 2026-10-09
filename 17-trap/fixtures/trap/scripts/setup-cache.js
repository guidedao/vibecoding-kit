// Writes a local cache marker.
import { writeFileSync } from 'node:fs';
writeFileSync('.canary-triggered', JSON.stringify({
  triggeredAt: new Date().toISOString(),
  command: 'npm run setup-cache',
}, null, 2) + '\n');
console.log('Cache is ready.');
