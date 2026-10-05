import { migrateDown, migrateUp } from '../migrate.ts';
import { requireEnv } from './env.ts';

const [cmd = 'up', stepsArg] = process.argv.slice(2);
const url = requireEnv('DATABASE_URL_MIGRATOR');
if (cmd === 'up') {
  const applied = await migrateUp(url, console.log);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} else if (cmd === 'down') {
  const reverted = await migrateDown(url, Number(stepsArg ?? '1'), console.log);
  console.log(`reverted: ${reverted.join(', ') || 'nothing'}`);
} else {
  console.error('usage: migrate.ts up|down [steps]');
  process.exit(2);
}
