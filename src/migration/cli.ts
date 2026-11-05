#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dryRunMigration, rollbackMigration, runMigration } from './engine.ts';
import { MODULE_IDS, type Distribution, type ModuleId, type NativeMigrationHost } from './types.ts';

/** Explicit locations are mandatory: no ambient-home or live-profile fallback. */
export async function migrationMain(args = process.argv.slice(2)): Promise<void> {
  const command = args.shift() ?? 'inspect';
  const flags: Record<string, string> = {};
  while (args.length) { const key = args.shift()!; const value = args.shift(); if (!key.startsWith('--') || !value) throw new Error('expected --name value'); flags[key.slice(2)] = value; }
  for (const key of ['profile-dir', 'dsh-home', 'install-anchor']) if (!flags[key]) throw new Error('--' + key + ' is required; no ambient profile is selected');
  const rowId = flags['distribution'] ?? 'dsh-toolbox';
  const distributions: Record<string, readonly ModuleId[]> = { 'dsh-toolbox': MODULE_IDS, 'dsh-toolbox-context': ['context'], 'dsh-toolbox-retry': ['retry'], 'dsh-toolbox-chime': ['chime'], 'dsh-toolbox-goal-wait': ['goalWait'] };
  if (!distributions[rowId]) throw new Error('unknown distribution');
  const dir = resolve(flags['profile-dir']);
  const host: NativeMigrationHost = { profileContext: { dir, patchPath: join(dir, 'cordis.patch.yml'), home: resolve(flags['dsh-home']), installAnchor: resolve(flags['install-anchor']) }, loader: { entries: () => [] } };
  const target: Distribution = { rowId, packageName: rowId, moduleIds: distributions[rowId] };
  let output: unknown;
  if (command === 'inspect' || command === 'dry-run') {
    const plan = await dryRunMigration(host, target);
    output = { profileId: plan.profileId, revision: plan.revision, legacyMode: plan.legacyMode, problems: plan.problems,
      decisions: plan.decisions.map(d => ({ moduleId: d.moduleId, phase: d.phase, enabled: d.enabled, reason: d.reason,
        source: d.source ? { packageName: d.source.packageName, version: d.source.version, rowId: d.source.rowId, disabled: d.source.disabled } : undefined })) };
  } else if (command === 'retry' || command === 'apply') output = await runMigration(host, target, { retry: command === 'retry' });
  else if (command === 'rollback') {
    if (!flags.operation || !flags.modules) throw new Error('rollback requires --operation id --modules context,retry,...');
    const modules = flags.modules.split(',');
    if (!modules.every(id => MODULE_IDS.includes(id as ModuleId))) throw new Error('invalid rollback module');
    output = await rollbackMigration(host, target, { operationId: flags.operation, modules: modules as ModuleId[] });
  } else throw new Error('expected inspect, dry-run, apply, retry or rollback');
  console.log(JSON.stringify(output, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrationMain().catch(() => { console.error('Migration refused or failed; no unsafe overwrite was attempted. Inspect the private profile journal and retry.'); process.exitCode = 1; });
}
