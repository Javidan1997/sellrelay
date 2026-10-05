// Claims one job of the given kind, then dies with SIGKILL mid-handler (no cleanup, no lease release).
import { createPool, jobs } from '../../../../packages/persistence/src/index.ts';

const [url, kind] = process.argv.slice(2);
const pool = createPool(url!, { applicationName: 'crash-worker', max: 1 });
const claimed = await jobs.claimJobs(pool, 'crash-worker', {
  limit: 1,
  leaseSeconds: 2,
  kinds: [kind!],
});
process.stdout.write(`claimed:${claimed.length}\n`);
// Simulate a hard crash in the middle of the external call.
process.kill(process.pid, 'SIGKILL');
