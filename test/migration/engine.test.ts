import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspectMigration, dryRunMigration, runMigration, rollbackMigration, startAutomaticMigration } from '../../src/migration/index.ts';
import { profilePaths } from '../../src/migration/storage.ts';
import type { Distribution, LoaderEntry, NativeMigrationHost } from '../../src/migration/types.ts';

const require = createRequire(import.meta.url);
const anchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? require.resolve('@deepseek-ai/dsh/package.json');
const target: Distribution = { rowId: 'dsh-toolbox', packageName: 'dsh-toolbox', moduleIds: ['context','retry','chime','goalWait'] };
async function fixture(work: (f: {host: NativeMigrationHost; dir:string; root:string; entries:LoaderEntry[]}) => Promise<void>, legacy = true) {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-migrate-'));
  const dir = join(root, 'profiles', 'test'); const home = join(root, 'home');
  const oldHome=process.env.HOME,oldDsh=process.env.DSH_HOME;
  process.env.HOME=home;process.env.DSH_HOME=home;
  await mkdir(dir,{recursive:true}); await mkdir(home,{recursive:true});
  const bundle = async (name:string,version:string,row:object) => {
    const pkg=join(dir,'node_modules',name);await mkdir(pkg,{recursive:true});
    await writeFile(join(pkg,'package.json'),JSON.stringify({name,version,dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
    await writeFile(join(pkg,'cordis.patch.yml'),JSON.stringify([{insert:[row]}]));
    await writeFile(join(pkg,'index.js'),'throw new Error("legacy modules MUST NOT load in discovery")');
  };
  await bundle('dsh-toolbox','0.1.0',{id:'dsh-toolbox',name:'dsh-toolbox',config:{modules:{}}});
  if(legacy) await bundle('dsh-stream-retry','0.1.9',{id:'stream-retry',name:'dsh-stream-retry',config:{errorCodes:[],providers:[],retryEmptyResponse:false}});
  await writeFile(join(dir,'package.json'),JSON.stringify({dependencies:{'dsh-toolbox':'*',...(legacy?{'dsh-stream-retry':'*'}:{})},dsh:{profile:{bundles:['dsh-toolbox',...(legacy?['dsh-stream-retry']:[])]}}}));
  await writeFile(join(dir,'cordis.patch.yml'),'[]\n'.replace('\\n','\n'));
  const entries:LoaderEntry[]=[];
  const host:NativeMigrationHost={profileContext:{dir,patchPath:join(dir,'cordis.patch.yml'),installAnchor:anchor,home},loader:{entries:()=>entries},get:()=>({})};
  try {await work({host,dir,root,entries});} finally {process.env.HOME=oldHome;process.env.DSH_HOME=oldDsh;await rm(root,{recursive:true,force:true});}
}
test('pure discovery/dry-run leaves complete profile untouched',async()=>fixture(async({host,dir})=>{
  const before=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  const plan=await dryRunMigration(host,target);
  assert.equal(plan.decisions.find(d=>d.moduleId==='retry')?.config?.retryEmptyResponse,false);
  assert.equal(plan.decisions.find(d=>d.moduleId==='context')?.enabled,false);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),before);
  assert.deepEqual(await readdir(dir),['cordis.patch.yml','node_modules','package.json']);
}));
test('journaled import disables bundles, preserves empty arrays, gates until actual target values',async()=>fixture(async({host,dir,entries})=>{
  const report=await runMigration(host,target);
  assert.equal(report.modules.retry?.ready,false);
  const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles,['dsh-toolbox']);
  const input=await inspectMigration(host,target);
  const config=input.rows.find(row=>row.id==='dsh-toolbox')!.config as Record<string,unknown>;
  assert.deepEqual((config.modules as any).retry.errorCodes,[]);
  entries.push({id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2,effectiveConfig:config}});
  const again=await runMigration(host,target);
  assert.equal(again.modules.retry?.ready,true);
  assert.equal(again.operationId,report.operationId);
  const paths=await profilePaths(host,target.rowId);
  assert.equal((await stat(paths.journal)).mode&0o777,0o600);
  assert.equal((await stat(paths.root)).mode&0o777,0o700);
}));
for(const stage of ['before-backup','after-backup','after-journal','before-target','after-target','before-disable','after-disable','before-bundles','after-bundles','after-saved']) {
  test('fault recovery is idempotent at '+stage,async()=>fixture(async({host,dir})=>{
    await assert.rejects(runMigration(host,target,{checkpoint:at=>{if(at===stage)throw new Error('injected');}}));
    await runMigration(host,target,{retry:true});
    const first=await readFile(join(dir,'cordis.patch.yml'),'utf8');
    await runMigration(host,target,{retry:true});
    assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),first);
  }));
}
test('concurrent edit after prepare never gets overwritten',async()=>fixture(async({host,dir})=>{
  await assert.rejects(runMigration(host,target,{checkpoint:async stage=>{if(stage==='after-journal'){await writeFile(join(dir,'cordis.patch.yml'),'# external edit\n[]\n');throw new Error('stop');}}}));
  const changed=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  await assert.rejects(runMigration(host,target,{retry:true}),/concurrent profile edit/);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),changed);
}));
test('two callers serialize under native lock without duplicate imports',async()=>fixture(async({host})=>{
  const [a,b]=await Promise.all([runMigration(host,target),runMigration(host,target)]);
  assert.equal(a.operationId,b.operationId);
}));
test('selective rollback closes new module and requires restart before old owner restoration',async()=>fixture(async({host,dir})=>{
  const first=await runMigration(host,target);
  const result=await rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']});
  assert.equal(result.modules.retry?.ready,false);
  assert.equal(result.modules.retry?.phase,'restart-required');
  const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles,['dsh-toolbox']);
}));
test('bootstrap does not enter inherited HMR context or wait for own Loader',async()=>fixture(async({host})=>{
  const als=new AsyncLocalStorage<boolean>();
  let ready!:()=>void;
  host.appReady={onReady:listener=>{ready=listener;return()=>{};}};
  host.get=()=>{throw new Error('no HMR access allowed during mutation');};
  const controller=als.run(true,()=>startAutomaticMigration(host,target));
  assert.equal(controller.state().modules.retry?.ready,false);
  ready();
  // The timer is unref'ed for host lifecycle; keep test process alive until settled.
  const keep=setInterval(()=>{},1000);
  try {const result=await controller.settled;assert.notEqual(result.modules.retry?.phase,'pending');} finally {clearInterval(keep);controller.dispose();}
}));
test('fresh installation opens only supported module gates without profile writes',async()=>fixture(async({host,dir})=>{
  const report=await runMigration(host,target);
  assert.equal(report.modules.context?.ready,true);
  assert.equal(report.modules.context?.enabled,true);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),'[]\n'.replace('\\n','\n'));
},false));
function childRun(host: NativeMigrationHost, body: string): unknown {
  const script = "import {runMigration,rollbackMigration} from " + JSON.stringify(new URL('../../src/migration/engine.ts',import.meta.url).href) + ";const target=" + JSON.stringify(target) + "; const host={profileContext:" + JSON.stringify(host.profileContext) + ",loader:{entries:()=>[{id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2}}]},get:()=>({})};" + body;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env}});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
}
test('selective rollback restores only owned legacy switch after original observed host exits',async()=>fixture(async({host,dir})=>{
  const first=childRun(host,"const report=await runMigration(host,target); await rollbackMigration(host,target,{operationId:report.operationId,modules:['retry']}); console.log(JSON.stringify(report));") as {operationId:string};
  const doc=parse(await readFile(join(dir,'cordis.patch.yml'),'utf8'));
  doc.push({insert:[{id:'unrelated-after-migration',name:'fixture-unrelated',config:{keep:true}}]});
  // Preserve an unrelated later manual row, including through selective recovery.
  await writeFile(join(dir,'cordis.patch.yml'),JSON.stringify(doc));
  // JSON rendering dropped the owned comment, intentionally making recovery refuse instead of guessing.
  await assert.rejects(rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']}),/legacy override changed/);
}));
test('selective rollback second phase succeeds when exact owned switch remains',async()=>fixture(async({host,dir})=>{
  const first=childRun(host,"const report=await runMigration(host,target); await rollbackMigration(host,target,{operationId:report.operationId,modules:['retry']}); console.log(JSON.stringify(report));") as {operationId:string};
  const before=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  await writeFile(join(dir,'cordis.patch.yml'),before+'\n# unrelated later comment\n');
  const report=await rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']});
  assert.equal(report.modules.retry?.phase,'rolled-back');
  assert.ok((await readFile(join(dir,'cordis.patch.yml'),'utf8')).includes('unrelated later comment'));
  assert.ok(JSON.parse(await readFile(join(dir,'package.json'),'utf8')).dsh.profile.bundles.includes('dsh-stream-retry'));
  await rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']});
}));
test('newer target-module edits are never replaced by rollback',async()=>fixture(async({host,dir})=>{
  const first=await runMigration(host,target);
  const text=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  await writeFile(join(dir,'cordis.patch.yml'),text.replace('retryEmptyResponse: false','retryEmptyResponse: true'));
  await assert.rejects(rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']}),/newer module edit/);
}));
