// Compile-only check that the public typings are usable. Run: npm run typecheck
import { seal, open, sealFile, openFile, inspect, attachSignature, walletMessage, LockraError, QUICKNET, type OpenResult } from '../index.js';

async function example(): Promise<void> {
  const capsule = await seal('hello', { unlockAt: new Date('2030-01-01'), label: 'Hi', by: 'me' });
  const later = await seal('hello', { unlockIn: 60, chain: QUICKNET });
  const r: OpenResult = await open(capsule.link, { wait: true, timeoutMs: 1000 });
  if (r.status === 'opened') r.message.toUpperCase();
  else r.secondsLeft.toFixed();

  const { file } = await sealFile(new Uint8Array(1), { name: 'a.txt', unlockIn: 60 });
  const f = await openFile(file);
  if (f.status === 'opened') f.file.data.byteLength.toFixed();

  inspect(later.token).unlockAt.toISOString();
  attachSignature(capsule, { address: '0x', signature: walletMessage(capsule) });

  try {
    await open('x');
  } catch (e) {
    if (e instanceof LockraError && e.code === 'TAMPERED') e.message.trim();
  }

  // @ts-expect-error: unlockAt and unlockIn are mutually exclusive
  await seal('x', { unlockAt: 1, unlockIn: 1 });
}
void example;
