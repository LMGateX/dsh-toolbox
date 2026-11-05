import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { distributions } from './distributions.mjs';
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'artifacts');
await mkdir(out, { recursive: true });
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const checksums = [];
for (const { name } of distributions) {
  const stdout = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { cwd: join(root, 'dist', name), encoding: 'utf8' });
  const result = JSON.parse(stdout);
  if (result.length !== 1 || result[0].name !== name || result[0].version !== version) throw new Error('Unexpected pack identity for ' + name);
  const filename = result[0].filename;
  const bytes = await readFile(join(out, filename));
  checksums.push(createHash('sha256').update(bytes).digest('hex') + '  ' + filename);
  console.log(name + '@' + version + ': ' + filename + ' (' + bytes.length + ' bytes)');
}
await writeFile(join(out, 'SHA256SUMS'), checksums.join('\n') + '\n');
const expected = distributions.map(d => d.name + '-' + version + '.tgz');
for (const filename of expected) if (!(await readdir(out)).includes(filename)) throw new Error('Missing artifact: ' + filename);
