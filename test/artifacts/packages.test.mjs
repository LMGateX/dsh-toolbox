import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, mkdir, readdir, symlink, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {distributions} from '../../scripts/distributions.mjs';
const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const artifactDir = join(root,'artifacts');
const checksums = new Map((await readFile(join(artifactDir,'SHA256SUMS'),'utf8')).trim().split('\n').map(line => line.split('  ').reverse()));
const hostRequire = createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'));
for(const {name,modules} of distributions) test('packed installable distribution: '+name,{timeout:120000},async t=>{
  const archive=join(artifactDir,name+'-'+version+'.tgz');
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),checksums.get(name+'-'+version+'.tgz'));
  const temp=await mkdtemp(join(root,'.sandbox-consumer-'));
  t.after(async()=>{assert.ok(temp.startsWith(join(root,'.sandbox-consumer-')));await rm(temp,{recursive:true,force:true});});
  await writeFile(join(temp,'package.json'),JSON.stringify({name:'toolbox-clean-consumer',private:true,type:'module'}));
  // Use npm itself, not source imports. Optional host peers must not install a second runtime.
  execFileSync('npm',['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',archive],{cwd:temp,stdio:'pipe',timeout:90000});
  const packageDir=join(temp,'node_modules',name);
  const pkg=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));
  assert.equal(pkg.version,version);assert.equal(pkg.name,name);assert.equal(pkg.private,undefined);
  assert.equal(pkg.engines.dsh,'0.2.2-alpha.3');assert.equal(pkg.dsh.client.platform,'web');
  assert.equal(pkg.dsh.client.platforms,undefined);assert.equal(pkg.dsh.bundle.patch,'cordis.patch.yml');
  const patch=await readFile(join(packageDir,'cordis.patch.yml'),'utf8');assert.ok(patch.includes('id: '+name));
  const listing=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n');
  assert.ok(!listing.some(file=>file.includes('node_modules/')||file.includes('.dsh-toolbox/')||file.includes('.env')));
  const server=await readFile(join(packageDir,'lib/index.js'),'utf8');
  const browser=await readFile(join(packageDir,'lib/client.js'),'utf8');
  assert.ok(browser.includes(name));assert.ok(browser.includes('__ModuleLoader__'));
  for(const id of ['context','retry','chime','goalWait']) {
    const notice=listing.some(file=>file==='package/notices/'+id+'.txt');
    assert.equal(notice,modules.includes(id),'selected feature notice '+id);
  }
  assert.equal(listing.some(file=>file.endsWith('/chime-soft.wav')),modules.includes('chime'));
  if(!modules.includes('chime')) {assert.ok(!browser.includes('data:audio/wav'));assert.ok(!browser.includes('AudioContext'));}
  if(!modules.includes('context'))assert.ok(!server.includes('function selectNativeRetentionRange'));
  if(!modules.includes('goalWait'))assert.ok(!server.includes('class GoalWaitGate'));
  assert.ok(!listing.some(file=>file.startsWith('package/node_modules/@deepseek-ai/dsh/')));
  // Host imports resolve against one anchored runtime in the isolated consumer, as DSH does.
  const imports=[...server.matchAll(/from ["'](@deepseek-ai\/[^"']+)["']/g)].map(match=>match[1]);
  await mkdir(join(temp,'node_modules','@deepseek-ai'),{recursive:true});
  for(const spec of new Set(imports)) {
    if(spec==='@deepseek-ai/schemastery')continue;
    const dir=join(temp,'node_modules',spec);
    try {await symlink(resolve(hostRequire.resolve(spec+'/package.json'),'..'),dir,'dir');} catch(error) {if(error.code!=='EEXIST')throw error;}
  }
  const entry=await import(pathToFileURL(join(packageDir,'lib/index.js')).href);
  assert.equal(entry.name,name);assert.equal(typeof entry.apply,'function');
  assert.deepEqual(Object.keys(entry.Config.dict.modules.dict),modules);
  const migration=await import(pathToFileURL(join(packageDir,'lib/migration.js')).href);
  assert.equal(typeof migration.startAutomaticMigration,'function');
  const help=execFileSync(process.execPath,[join(packageDir,'lib/migrate.js'),'--help'],{encoding:'utf8',env:{...process.env,HOME:temp,DSH_HOME:join(temp,'dsh-home')}});
  assert.ok(help.includes('profile')&&help.includes('inspect'));
});
