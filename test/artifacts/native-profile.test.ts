import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'package.json'));
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json');
const dshPackage = JSON.parse(await readFile(dshManifest, 'utf8'));
const cli = join(dirname(dshManifest), dshPackage.bin.dsh);
const version = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const artifacts = resolve(process.env.DSH_TOOLBOX_ARTIFACT_DIR ?? join(root, 'artifacts'));

function environment(temp: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME:temp, DSH_HOME:join(temp,'dsh-home'), XDG_CACHE_HOME:join(temp,'cache'), XDG_CONFIG_HOME:join(temp,'config'), XDG_DATA_HOME:join(temp,'data'), npm_config_cache:join(temp,'npm-cache'), CI:'1', NO_COLOR:'1' };
}

async function native(temp: string, args: string[]) {
  try { return (await run(process.execPath, [cli, ...args], { cwd:temp, env:environment(temp), timeout:120000, maxBuffer:8*1024*1024 })).stdout; }
  catch (error: any) { throw new Error('Native DSH failed: ' + args.join(' ') + '\n' + String(error.stdout ?? '') + String(error.stderr ?? ''), {cause:error}); }
}

test('native CLI installs packed combined distribution into isolated web profile', {timeout:180000}, async t => {
  const temp = await mkdtemp(join(root,'.sandbox-native-'));
  let stopNative=async()=>{};let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{await browser?.close();await stopNative();if(process.env.DSH_TOOLBOX_KEEP_NATIVE)console.log('Retained native acceptance sandbox:',temp);else{assert.ok(temp.startsWith(join(root,'.sandbox-native-')));await rm(temp,{recursive:true,force:true});}});
  const seed=process.env.DSH_TOOLBOX_NATIVE_SEED;
  if(seed){assert.ok(resolve(seed).startsWith(join(root,'.sandbox-native-')),'Cache seed must be a retained test sandbox');await cp(join(seed,'cache'),join(temp,'cache'),{recursive:true});await cp(join(seed,'data'),join(temp,'data'),{recursive:true});}
  const profile = 'acceptance';
  const initial = await native(temp,['--profile',profile,'--from-default-profile','web','--dump-config']);
  assert.ok(initial.includes('web-app'));
  const installed = await native(temp,['plugin','--profile',profile,'add',join(artifacts,'dsh-toolbox-'+version+'.tgz'),'--ignore-scripts','--no-optional','--config.auto-install-peers=false',...(seed?['--offline']:[])]);
  assert.ok(installed.includes('dsh-toolbox'));
  const packageFile = join(environment(temp).DSH_HOME!,'profiles',profile,'package.json');
  const pkg = JSON.parse(await readFile(packageFile,'utf8'));
  assert.ok(pkg.dependencies['dsh-toolbox']);
  const composed = parse(await native(temp,['--profile',profile,'--dump-config']),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]});
  assert.ok(JSON.stringify(composed).includes('dsh-toolbox'));
  const child = spawn(process.execPath,[cli,'--profile',profile,'--host','127.0.0.1','--port','0','--no-open'],{cwd:temp,env:environment(temp),stdio:['ignore','pipe','pipe'],detached:true});
  const exited = once(child,'close'); let log = '';
  const clean = (text:string) => text.replace(/(https?:\/\/[^\s?#]+)[^\s]*/g,'$1/[redacted]');
  stopNative=async()=>{if(child.exitCode===null&&child.signalCode===null){process.kill(-child.pid!,'SIGTERM');const force=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},8000);force.unref();await exited;clearTimeout(force);}};
  const url = await new Promise<string>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Native startup timed out\n'+clean(log))),30000);
    const capture=(data:Buffer)=>{log+=data;const match=log.match(/dsh web: (https?:\/\/\S+)/);if(match){clearTimeout(timeout);resolve(match[1]!);}};
    child.stdout!.on('data',capture);child.stderr!.on('data',capture);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Native exit '+code+'\n'+clean(log)));});child.once('error',reject);
  });
  assert.notEqual(new URL(url).port,'3080');
  browser=await chromium.launch({executablePath:process.env.DSH_TOOLBOX_CHROMIUM,headless:true,args:['--no-sandbox'],env:environment(temp) as Record<string,string>});
  const page=await browser.newPage();page.setDefaultTimeout(5000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text().split('\n')[0]!.slice(0,500));});
  await page.goto(url);await page.waitForFunction(()=>Boolean((globalThis as any).__DSH_BOOT__));
  const entry=await page.evaluate(()=>((globalThis as any).__DSH_BOOT__.entries as any[]).find(entry=>entry.id==='dsh-toolbox'));
  assert.ok(entry);assert.equal(entry.inject.includes('@deepseek-ai/dsh-client-ui-settings'),true);
  const served=await page.request.get(new URL(entry.url,url).href);assert.equal(served.status(),200);
  const packedClient=await readFile(join(environment(temp).DSH_HOME!,'profiles',profile,'node_modules','dsh-toolbox','lib','client.js'));
  const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
  const normalize=(value:Buffer)=>value.toString().replace(/\/\/# sourceMappingURL=[^\r\n]*\s*$/,'').replace(/\n;\s*$/,'\n').trimEnd();
  assert.equal(sha(normalize(await served.body())),sha(normalize(packedClient)),'only native source-map trailer and concat separator differ from installed packed client');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('dialog',{name:'Get started',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Plugins',exact:true}).click();
  await page.getByText('dsh-toolbox',{exact:true}).first().waitFor({timeout:15000});
  assert.equal(await page.getByText('dsh-toolbox',{exact:true}).count(),1);
  await page.getByRole('button',{name:'View dsh-toolbox',exact:true}).click();
  await page.getByRole('button',{name:'Configure dsh-toolbox',exact:true}).click();
  await page.locator('[data-package="dsh-toolbox"]').waitFor();
  assert.equal(await page.locator('[data-module]').count(),4);
  const moduleStatus=await page.evaluate(async()=>{const response=await fetch('/toolbox/dsh-toolbox/status',{credentials:'same-origin',cache:'no-store'});return {code:response.status,body:await response.json()};});
  assert.equal(moduleStatus.code,200);assert.equal(moduleStatus.body.modules.chime.ready,true);
  assert.deepEqual(Object.keys(moduleStatus.body.modules).sort(),['chime','context','goalWait','retry']);
  console.log('Native module phases:',Object.fromEntries(Object.entries(moduleStatus.body.modules).map(([id,value])=>[id,(value as any).phase])));
  const delay=page.locator('[data-module="context"] [data-field="retryDelayMs"]');
  await delay.locator('input').fill('3.5');await delay.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>!(document.querySelectorAll('[data-module="context"] [data-field="retryDelayMs"] button')[2] as HTMLButtonElement)?.disabled);
  assert.deepEqual(await delay.getByRole('alert').allTextContents(),[]);
  await page.getByRole('checkbox',{name:'Enable Stream and empty-response retry',exact:true}).click();
  await page.waitForFunction(()=>!(document.querySelector('[data-module=retry] input[data-field=enabled]') as HTMLInputElement)?.checked);
  await page.getByRole('button',{name:'🔔 正常',exact:true}).click();
  await page.getByRole('button',{name:'🌙 休息中',exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'🌙 休息中',exact:true}).waitFor();
  await page.getByRole('dialog',{name:'Get started',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Plugins',exact:true}).click();
  await page.getByRole('button',{name:'View dsh-toolbox',exact:true}).click();
  await page.getByRole('button',{name:'Configure dsh-toolbox',exact:true}).click();
  await page.locator('[data-package="dsh-toolbox"]').waitFor();
  assert.equal(await page.locator('[data-module="context"] [data-field="retryDelayMs"] input').inputValue(),'3.5');
  assert.equal(await page.getByRole('checkbox',{name:'Enable Stream and empty-response retry',exact:true}).isChecked(),false);
  const chimeSection=page.locator('[data-module="chime"]');
  await chimeSection.locator('#dsh-session-chime-enabled').uncheck();
  await chimeSection.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'🌙 休息中',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-module]').count(),4,'disabled chime keeps sibling configuration available');
  assert.deepEqual(await chimeSection.getByRole('alert').allTextContents(),[]);
  const persisted=await readFile(join(environment(temp).DSH_HOME!,'profiles',profile,'cordis.patch.yml'),'utf8');
  const accepted=parse(persisted).find((row:any)=>row.id==='dsh-toolbox').config.modules;
  assert.equal(accepted.context.retryDelayMs,3500);assert.equal(accepted.retry.enabled,false);assert.equal(accepted.chime.restMode,true);assert.equal(accepted.chime.enabled,false);
  assert.deepEqual(errors,[]);
  console.log('Native startup log:',clean(log).slice(-3000));
});

test('all five packed manifests compose through native CLI; distinct split peers coexist', {timeout:180000}, async t=>{
  const temp=await mkdtemp(join(root,'.sandbox-native-'));
  t.after(async()=>{assert.ok(temp.startsWith(join(root,'.sandbox-native-')));await rm(temp,{recursive:true,force:true});});
  const seed=process.env.DSH_TOOLBOX_NATIVE_SEED;
  if(seed){assert.ok(resolve(seed).startsWith(join(root,'.sandbox-native-')));await cp(join(seed,'cache'),join(temp,'cache'),{recursive:true});await cp(join(seed,'data'),join(temp,'data'),{recursive:true});}
  const names=['dsh-toolbox','dsh-toolbox-context','dsh-toolbox-retry','dsh-toolbox-chime','dsh-toolbox-goal-wait'];
  const flatten=(value:any):any[]=>Array.isArray(value)?value.flatMap(flatten):value&&typeof value==='object'?[...(typeof value.id==='string'?[value]:[]),...Object.values(value).flatMap(flatten)]:[];
  for(const [index,name] of names.entries()){
    const profile='compose-'+index;
    await native(temp,['--profile',profile,'--from-default-profile','web','--dump-config']);
    await native(temp,['plugin','--profile',profile,'add',join(artifacts,name+'-'+version+'.tgz'),'--ignore-scripts','--no-optional','--config.auto-install-peers=false',...(seed?['--offline']:[])]);
    const output=await native(temp,['--profile',profile,'--dump-config']);
    const rows=flatten(parse(output,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]}));
    assert.equal(rows.filter(row=>row.id===name&&row.name===name).length,1,name+' inserted exactly once');
    const profileDir=join(environment(temp).DSH_HOME!,'profiles',profile);
    const pkg=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'));
    assert.ok(pkg.dependencies[name]);assert.ok(pkg.dsh.profile.bundles.includes(name));
    const manifest=JSON.parse(await readFile(join(profileDir,'node_modules',name,'package.json'),'utf8'));
    assert.equal(manifest.dsh.client.platform,'web');assert.equal(manifest.dsh.bundle.patch,'cordis.patch.yml');
  }
  const profile='split-peers';await native(temp,['--profile',profile,'--from-default-profile','web','--dump-config']);
  await native(temp,['plugin','--profile',profile,'add',...names.slice(1).map(name=>join(artifacts,name+'-'+version+'.tgz')),'--ignore-scripts','--no-optional','--config.auto-install-peers=false',...(seed?['--offline']:[])]);
  const peerRows=flatten(parse(await native(temp,['--profile',profile,'--dump-config']),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]}));
  for(const name of names.slice(1))assert.equal(peerRows.filter(row=>row.id===name).length,1);
  assert.equal(peerRows.some(row=>row.id==='dsh-toolbox'),false);
});
