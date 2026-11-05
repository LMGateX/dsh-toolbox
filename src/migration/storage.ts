import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { NativeMigrationHost } from './types.ts';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** Permission-private, same-filesystem rename commit; fsync payload before publication. */
export async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  // Directory sync is supported on Unix; Windows may refuse opening directories.
  try { const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch (error) { if (process.platform !== 'win32') throw error; }
}
export async function profilePaths(host: NativeMigrationHost, rowId: string) {
  if (!/^[a-z0-9-]+$/.test(rowId)) throw new Error('unsafe distribution identity');
  const dir = await realpath(host.profileContext.dir);
  if (resolve(host.profileContext.patchPath) !== join(dir, 'cordis.patch.yml')) throw new Error('nonstandard profile patch location');
  const root = join(dir, '.dsh-toolbox');
  return { dir, root, manifest: join(dir, 'package.json'), patch: join(dir, 'cordis.patch.yml'), journal: join(root, digest(rowId).slice(0, 24) + '.json') };
}
/** Share native management's exact writer lock; never wait for HMR while holding it. */
export async function withProfileLock<T>(host: NativeMigrationHost, operation: () => Promise<T>): Promise<T> {
  const { manifest } = await profilePaths(host, 'lock');
  const require = createRequire(host.profileContext.installAnchor);
  const native = require('@deepseek-ai/dsh-atomic-write') as { withFileLock<T>(path: string, work: () => Promise<T>, options: { waitMs: number }): Promise<T> };
  return native.withFileLock(manifest, operation, { waitMs: 1500 });
}
