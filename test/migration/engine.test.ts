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
  const host:NativeMigrationHost={profileContext:{dir,patchPath:join(dir,'cordis.patch.yml'),installAnchor:anchor,home},loader:{entries:()=>entries},get:()=>({}),handoverAcknowledged:()=>true};
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
  host.moduleConfig=()=>({enabled:true});
  const report=await runMigration(host,target);
  assert.equal(report.modules.context?.ready,true);
  assert.equal(report.modules.context?.enabled,true);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),'[]\n'.replace('\\n','\n'));
},false));
function childRun(host: NativeMigrationHost, body: string, observed = true): unknown {
  const script = "import {runMigration,rollbackMigration} from " + JSON.stringify(new URL('../../src/migration/engine.ts',import.meta.url).href) + ";const target=" + JSON.stringify(target) + "; const host={profileContext:" + JSON.stringify(host.profileContext) + ",loader:{entries:()=>" + (observed ? "[{id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2}}]" : "[]") + "},get:()=>({})};" + body;
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
test('chime reload timestamp finalizes only after fresh host and remains stable',async()=>fixture(async({host,dir,entries})=>{
  const pkg=join(dir,'node_modules','dsh-session-chime');await mkdir(pkg,{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'dsh-session-chime',version:'0.6.0',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
  await writeFile(join(pkg,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'session-chime',name:'dsh-session-chime'}]}]));
  const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));manifest.dependencies['dsh-session-chime']='*';manifest.dsh.profile.bundles.push('dsh-session-chime');await writeFile(join(dir,'package.json'),JSON.stringify(manifest));
  const first=childRun(host,"const report=await runMigration(host,target);console.log(JSON.stringify(report));") as {browserReloadAfter:number;modules:any};
  assert.equal(first.modules.chime.ready,false);
  const discovered=await inspectMigration(host,target);const config=discovered.rows.find(row=>row.id==='dsh-toolbox')!.config;
  entries.push({id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2,effectiveConfig:config}});
  assert.equal((await runMigration(host,target)).modules.chime?.ready,false,'a process started before migration cannot masquerade as fresh host');
  const inspectUrl=JSON.stringify(new URL('../../src/migration/discovery.ts',import.meta.url).href);
  const body="const {inspectMigration}=await import("+inspectUrl+");const input=await inspectMigration(host,target);const config=input.rows.find(row=>row.id==='dsh-toolbox').config;host.moduleConfig=id=>config.modules[id];const report=await runMigration(host,target);console.log(JSON.stringify(report));";
  const second=childRun(host,body) as {browserReloadAfter:number;modules:any};
  assert.equal(second.modules.chime.ready,true);assert.ok(second.browserReloadAfter>=first.browserReloadAfter);
  const third=childRun(host,body) as {browserReloadAfter:number};
  assert.equal(third.browserReloadAfter,second.browserReloadAfter);
},false));
for (const interrupted of ['after-journal','after-target','after-disable']) for (const mutation of ['HOME overlay', 'launcher overlay', 'source version', 'source config']) {
  test('retry refuses changed immutable environment at '+interrupted+': ' + mutation, async () => fixture(async ({host, dir}) => {
    await assert.rejects(runMigration(host, target, {checkpoint: stage => {if(stage === interrupted) throw new Error('crash before commit');}}));
    const patch = await readFile(join(dir, 'cordis.patch.yml'), 'utf8');
    const manifest = await readFile(join(dir, 'package.json'), 'utf8');
    if (mutation === 'HOME overlay') await writeFile(join(host.profileContext.home, 'cordis.patch.yml'), JSON.stringify([{id:'stream-retry',config:{retryEmptyResponse:true}}]));
    if (mutation === 'launcher overlay') host.profileContext.overlays = [{id:'stream-retry',disabled:false}];
    if (mutation === 'source version') {
      const path=join(dir,'node_modules','dsh-stream-retry','package.json');
      const value=JSON.parse(await readFile(path,'utf8')); value.version='0.1.8'; await writeFile(path,JSON.stringify(value));
    }
    if (mutation === 'source config') await writeFile(join(dir,'node_modules','dsh-stream-retry','cordis.patch.yml'),JSON.stringify([{insert:[{id:'stream-retry',name:'dsh-stream-retry',config:{retryEmptyResponse:true}}]}]));
    await assert.rejects(runMigration(host,target,{retry:true}),/environment|ownership|input|concurrent/);
    assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),patch);
    assert.equal(await readFile(join(dir,'package.json'),'utf8'),manifest);
  }));
}
test('each ownership-changing stage revalidates overlay inputs after its checkpoint',async()=>fixture(async({host,dir})=>{
  const manifest=await readFile(join(dir,'package.json'),'utf8');
  await assert.rejects(runMigration(host,target,{checkpoint:async stage=>{
    if(stage==='before-disable') await writeFile(join(host.profileContext.home,'cordis.patch.yml'),JSON.stringify([{id:'stream-retry',disabled:false}]));
  }}),/environment|ownership|input|concurrent/);
  assert.equal(await readFile(join(dir,'package.json'),'utf8'),manifest);
  assert.ok(!(await readFile(join(dir,'cordis.patch.yml'),'utf8')).includes('dsh-toolbox-migration:'));
}));
test('all persisted absent modules stay gated until the running root adopts their off config',async()=>fixture(async({host,entries})=>{
  host.moduleConfig=()=>({enabled:true});
  const first=await runMigration(host,target);
  assert.equal(first.modules.context?.ready,false);
  assert.equal(first.modules.chime?.ready,false);
  const input=await inspectMigration(host,target);const config=input.rows.find(row=>row.id===target.rowId)!.config as any;
  entries.push({id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2,effectiveConfig:config}});
  host.moduleConfig=id=>config.modules[id];
  assert.equal((await runMigration(host,target)).modules.context?.ready,true);
}));
test('rollback fences current host B after migration host A exited',async()=>fixture(async({host,dir,entries})=>{
  const first=childRun(host,"const report=await runMigration(host,target);console.log(JSON.stringify(report));") as {operationId:string};
  const input=await inspectMigration(host,target);const config=input.rows.find(row=>row.id===target.rowId)!.config as any;
  let finish!:()=>void;const disposing=new Promise<void>(resolve=>{finish=resolve;});
  entries.push({id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2,effectiveConfig:config,inertia:disposing}});
  host.moduleConfig=id=>config.modules[id];
  await runMigration(host,target); // B observes the saved journal before it may mount effects.
  await rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']});
  config.modules.retry.enabled=false;
  const again=await rollbackMigration(host,target,{operationId:first.operationId,modules:['retry']});
  assert.equal(again.modules.retry?.phase,'restart-required');
  assert.ok(!JSON.parse(await readFile(join(dir,'package.json'),'utf8')).dsh.profile.bundles.includes('dsh-stream-retry'));
  finish(); // Settling a child disposer does not forge proof that B stopped.
}));
test('offline-created journal can restore legacy when no target runtime ever registered',async()=>fixture(async({host,dir})=>{
  const created=childRun(host,"const result=await runMigration(host,target);console.log(JSON.stringify(result));",false) as {operationId:string};
  await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']});
  const done=await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']});
  assert.equal(done.modules.retry?.phase,'rolled-back');
  assert.ok(JSON.parse(await readFile(join(dir,'package.json'),'utf8')).dsh.profile.bundles.includes('dsh-stream-retry'));
}));
test('offline-created journal registers later host B before ready and blocks recovery until B exits',async()=>fixture(async({host,dir})=>{
  const created=childRun(host,"const result=await runMigration(host,target);console.log(JSON.stringify(result));",false) as {operationId:string};
  const discoveryUrl=JSON.stringify(new URL('../../src/migration/discovery.ts',import.meta.url).href);
  const engineUrl=JSON.stringify(new URL('../../src/migration/engine.ts',import.meta.url).href);
  const script="import {runMigration} from "+engineUrl+";import {inspectMigration} from "+discoveryUrl+";const target="+JSON.stringify(target)+";const host={profileContext:"+JSON.stringify(host.profileContext)+",loader:{entries:()=>[{id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2}}]},get:()=>({})};const input=await inspectMigration(host,target);host.moduleConfig=id=>input.rows.find(row=>row.id==='dsh-toolbox').config.modules[id];const report=await runMigration(host,target);process.send({ready:report.modules.retry.ready,pid:process.pid});process.on('message',()=>process.exit(0));";
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env},stdio:['ignore','ignore','pipe','ipc']});
  const exit=new Promise<void>((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error('host B failed')));child.once('error',reject);});
  try {
    const message=await new Promise<{ready:boolean;pid:number}>((resolve,reject)=>{child.once('message',value=>resolve(value as {ready:boolean;pid:number}));child.once('error',reject);});
    assert.equal(message.ready,true);
    const paths=await profilePaths(host,target.rowId);const recorded=JSON.parse(await readFile(paths.journal,'utf8'));
    assert.ok(recorded.owners.retry.some((origin:string)=>origin.startsWith(message.pid+':')),'B registered durably before ready was returned');
    await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']});
    assert.equal((await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']})).modules.retry?.phase,'restart-required');
    assert.ok(!JSON.parse(await readFile(join(dir,'package.json'),'utf8')).dsh.profile.bundles.includes('dsh-stream-retry'));
    child.send('stop');await exit;
    assert.equal((await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']})).modules.retry?.phase,'rolled-back');
  } finally {if(child.exitCode===null)child.kill('SIGKILL');await exit.catch(()=>{});}
}));
test('disabled host startup does not manufacture active target ownership',async()=>fixture(async({host,entries})=>{
  const created=childRun(host,"const result=await runMigration(host,target);console.log(JSON.stringify(result));",false) as {operationId:string};
  await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']});
  const input=await inspectMigration(host,target);const config=input.rows.find(row=>row.id===target.rowId)!.config as any;
  entries.push({id:'include:dsh-toolbox',options:{id:'dsh-toolbox',name:'dsh-toolbox'},fiber:{state:2,effectiveConfig:config}});host.moduleConfig=id=>config.modules[id];
  await runMigration(host,target);
  const paths=await profilePaths(host,target.rowId);const journal=JSON.parse(await readFile(paths.journal,'utf8'));
  assert.equal(journal.runtimeObserved,true);
  assert.ok(!(journal.owners.retry??[]).some((origin:string)=>origin.startsWith(process.pid+':')));
  assert.equal((await rollbackMigration(host,target,{operationId:created.operationId,modules:['retry']})).modules.retry?.phase,'rolled-back');
}));
test('auto=false partial migration keeps unadopted absent defaults gated and refreshes later explicit toggles',async()=>fixture(async({host,dir})=>{
  const before=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  const listeners=new Map<string,()=>void>();host.on=(name,callback)=>{listeners.set(name,callback);return()=>{listeners.delete(name);};};
  const current:Record<string,any>={context:{enabled:true},retry:{enabled:true},chime:{enabled:true},goalWait:{enabled:true}};
  host.moduleConfig=id=>current[id];
  const controller=startAutomaticMigration(host,{...target,auto:false});
  const keep=setInterval(()=>{},1000);
  try {
    const first=await controller.settled;
    assert.equal(first.modules.context?.ready,false);
    assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),before);
    await writeFile(join(dir,'cordis.patch.yml'),JSON.stringify([{id:target.rowId,config:{modules:{context:{enabled:true}}}}]));
    const updated=new Promise<void>(resolve=>{const off=controller.subscribe(state=>{if(state.modules.context?.ready){off();resolve();}});});
    listeners.get('loader/volatile-update')!();await updated;
    assert.equal(controller.state().modules.context?.ready,true);
    // Disable and re-enable remain owned by current root config, not historical migration enabled.
    current.context.enabled=false;await writeFile(join(dir,'cordis.patch.yml'),JSON.stringify([{id:target.rowId,config:{modules:{context:{enabled:false}}}}]));
    await controller.retry();assert.equal(controller.state().modules.context?.ready,true);
    current.context.enabled=true;await writeFile(join(dir,'cordis.patch.yml'),JSON.stringify([{id:target.rowId,config:{modules:{context:{enabled:true}}}}]));
    await controller.retry();assert.equal(controller.state().modules.context?.ready,true);
  } finally {clearInterval(keep);controller.dispose();}
}));
for(const executor of ['engine','CLI']) for(const config of [{pressureStep:0},{retryAttempts:6},{guidanceText:'x'.repeat(8001)},{ptcModelTimeouts:{'provider/model':0}}]) {
  test('standalone '+executor+' rejects invalid explicit context semantics before disabling its old owner '+Object.keys(config)[0],async()=>fixture(async({host,dir})=>{
    const pkg=join(dir,'node_modules','dsh-tool-compact-context');await mkdir(pkg,{recursive:true});
    await writeFile(join(pkg,'package.json'),JSON.stringify({name:'dsh-tool-compact-context',version:'0.4.7',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
    await writeFile(join(pkg,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'dsh-tool-compact-context',name:'dsh-tool-compact-context'}]}]));
    const path=join(dir,'package.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.dependencies['dsh-tool-compact-context']='*';manifest.dsh.profile.bundles.push('dsh-tool-compact-context');await writeFile(path,JSON.stringify(manifest));
    await writeFile(join(dir,'cordis.patch.yml'),JSON.stringify([{id:target.rowId,config:{modules:{context:config}}}]));
    const before=await readFile(path,'utf8');
    let result;
    if(executor==='engine')result=await runMigration(host,target);
    else {
      const output=spawnSync(process.execPath,[new URL('../../src/migration/cli.ts',import.meta.url).pathname,'apply','--profile-dir',dir,'--dsh-home',host.profileContext.home,'--install-anchor',anchor],{env:{...process.env},encoding:'utf8'});
      assert.equal(output.status,0,output.stderr);result=JSON.parse(output.stdout);
    }
    assert.equal(result.modules.context?.phase,'conflict');assert.equal(await readFile(path,'utf8'),before);
    assert.ok(!(await readFile(join(dir,'cordis.patch.yml'),'utf8')).includes('name: dsh-tool-compact-context'));
  },false));
}
test('real standalone CLI apply and selective rollback complete without a target host ever starting',async()=>fixture(async({host,dir})=>{
  const cli=(command:string,args:string[]=[])=>{
    const child=spawnSync(process.execPath,[new URL('../../src/migration/cli.ts',import.meta.url).pathname,command,'--profile-dir',dir,'--dsh-home',host.profileContext.home,'--install-anchor',anchor,...args],{env:{...process.env},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
  };
  const applied=cli('apply');const args=['--operation',applied.operationId,'--modules','retry'];
  assert.equal(cli('rollback',args).modules.retry.phase,'restart-required');
  assert.equal(cli('rollback',args).modules.retry.phase,'rolled-back');
  assert.ok(JSON.parse(await readFile(join(dir,'package.json'),'utf8')).dsh.profile.bundles.includes('dsh-stream-retry'));
}));
test('old interrupted journal without immutable evidence is never resumed implicitly',async()=>fixture(async({host,dir})=>{
  await assert.rejects(runMigration(host,target,{checkpoint:stage=>{if(stage==='after-journal')throw new Error('interrupt');}}));
  const paths=await profilePaths(host,target.rowId);const journal=JSON.parse(await readFile(paths.journal,'utf8'));delete journal.environment;await writeFile(paths.journal,JSON.stringify(journal));
  const before=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  await assert.rejects(runMigration(host,target,{retry:true}),/no immutable input evidence/);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),before);
}));
for(const direction of ['rewound','future'])test('retry refuses '+direction+' profile image even when present elsewhere in the same journal',async()=>fixture(async({host,dir})=>{
  await assert.rejects(runMigration(host,target,{checkpoint:stage=>{if(stage===(direction==='rewound'?'before-disable':'after-journal'))throw new Error('interrupt');}}));
  const paths=await profilePaths(host,target.rowId);const journal=JSON.parse(await readFile(paths.journal,'utf8'));
  const image=direction==='rewound'?journal.steps[0].before:journal.steps.find((step:any)=>step.kind==='disable').after;
  await writeFile(join(dir,'cordis.patch.yml'),image);
  await assert.rejects(runMigration(host,target,{retry:true}),/concurrent profile edit/);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),image);
}));
