// Seal a file into a .lockra capsule, or open one.
// Run: node examples/seal-file.js seal ./photo.jpg 2027-01-01T00:00:00Z
//      node examples/seal-file.js open ./photo.jpg.lockra
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { sealFile, openFile } from 'lockra-sdk';

const [command, path, unlockAt] = process.argv.slice(2);

if (command === 'seal' && path && unlockAt) {
  const { capsule, file } = await sealFile(await readFile(path), { name: basename(path), unlockAt });
  await writeFile(`${path}.lockra`, file);
  console.log(`Wrote ${path}.lockra. It unlocks at ${capsule.unlockAt.toISOString()}.`);
} else if (command === 'open' && path) {
  const r = await openFile(await readFile(path));
  if (r.status === 'sealed') {
    console.log(`Still sealed until ${r.unlockAt.toISOString()}.`);
  } else {
    await writeFile(r.file.name, r.file.data);
    console.log(`Opened. Saved ${r.file.name} (${r.file.size} bytes).`);
  }
} else {
  console.log('Usage:\n  node examples/seal-file.js seal <file> <unlock ISO date>\n  node examples/seal-file.js open <file.lockra>');
  process.exitCode = 1;
}
