// Seal a message for 30 seconds, then wait for it to open.
// Run: node examples/basic.js
import { seal, open, inspect } from 'lockra-sdk';

const capsule = await seal('Hello from the past 👋', { unlockIn: 30, label: 'SDK demo', by: 'lockra-sdk' });
console.log('Sealed. Share this link:\n' + capsule.link);
console.log('Unlocks at', capsule.unlockAt.toISOString());

console.log('Right now:', (await open(capsule)).status); // "sealed"

const opened = await open(capsule, {
  wait: true,
  onWait: ({ retryInMs }) => console.log(`Still sealed, checking again in ${Math.round(retryInMs / 1000)}s...`),
});
console.log('Opened:', opened.message);
console.log('Public details:', inspect(capsule.link));
