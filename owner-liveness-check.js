import 'dotenv/config';
import { clearDepartedOwners } from './agent/doc-owners.js';
import log from './agent/logger.js';

export async function main() {
  const removed = await clearDepartedOwners();
  if (removed.length > 0) {
    log.warn(
      { module: 'owner-liveness-check', removedDocs: removed },
      'Removed departed owners — docs are now ownerless until reassigned via doc-owner/history/git-blame signals',
    );
  } else {
    log.debug({ module: 'owner-liveness-check' }, 'All doc owners still active');
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/owner-liveness-check.js') || process.argv[1].endsWith('\\owner-liveness-check.js'));
if (isMain) main();
