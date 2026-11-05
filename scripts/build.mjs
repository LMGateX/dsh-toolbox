import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { distributions, sourceDirectories, clientDependencies } from './distributions.mjs';
const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const hostPackages = ['cordis', 'cordis-plugin-loader', 'dsh-agent', 'dsh-app-boot', 'dsh-compaction', 'dsh-goal', 'dsh-jobs', 'dsh-llm', 'dsh-system-prompt', 'dsh-token-meter', 'dsh-tools', 'dsh-ptc-runtime', 'dsh-host-webserver', 'dsh-client-connection', 'dsh-hmr', 'schemastery'];
for (const { name, modules } of distributions) {
  const out = join(root, 'dist', name);
  await mkdir(join(out, 'lib'), {recursive: true});
  const imports = modules.map(id => 'import * as ' + id + ' from "./src/modules/' + sourceDirectories[id] + '/index.ts";').join('\n');
  const server = imports + '\nimport {createToolboxPlugin} from "./src/runtime.ts";\nconst p=createToolboxPlugin({name:' + JSON.stringify(name) + ',moduleIds:' + JSON.stringify(modules) + ',modulePlugins:{' + modules.join(',') + '}});\nexport const name=p.name,inject=p.inject,Config=p.Config,apply=p.apply;';
  await build({stdin: {contents: server, resolveDir: root, sourcefile: 'toolbox-server-entry.ts', loader: 'ts'}, outfile: join(out, 'lib/index.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/*'], sourcemap: true, legalComments: 'linked'});
  await build({entryPoints: [join(root, 'src/migration/index.ts')], outfile: join(out, 'lib/migration.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/*'], sourcemap: true, legalComments: 'linked'});
  await build({entryPoints: [join(root, 'src/migration/cli.ts')], outfile: join(out, 'lib/migrate.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/*'], sourcemap: true, legalComments: 'linked'});
  const hasChime = modules.includes('chime');
  const client = 'import {createToolboxClient} from "./client/index.ts";\n' + (hasChime ? 'import {createChimeAdapter} from "./client/chime.ts";\n' : '') + 'window.__ModuleLoader__.load({id:' + JSON.stringify(name) + ',factory(require){return createToolboxClient(' + JSON.stringify({rowId:name,packageName:name,moduleIds:modules}) + ',require("react")' + (hasChime ? ',createChimeAdapter' : '') + ');}});';
  await build({stdin: {contents: client, resolveDir: root, sourcefile: 'toolbox-client-entry.ts', loader: 'ts'}, outfile: join(out, 'lib/client.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', sourcemap: true, legalComments: 'linked'});
  await writeFile(join(out, 'cordis.patch.yml'), '# Generated from the same feature source as every Toolbox distribution.\ninsert:\n  - id: ' + name + '\n    name: ' + name + '\n    config: {}\n');
  const peers = Object.fromEntries(hostPackages.map(pkg => ['@deepseek-ai/' + pkg, pkg === 'cordis' ? '4.0.6-alpha.2' : pkg === 'schemastery' ? '~3.18.4' : '0.2.2-alpha.3']));
  const manifest = {
    name, version: source.version, description: name === 'dsh-toolbox' ? source.description : 'DSH Toolbox: ' + modules[0] + ' distribution', type: 'module', license: source.license,
    main: './lib/index.js', exports: {'.': './lib/index.js', './client': './lib/client.js', './migration': './lib/migration.js', './package.json': './package.json'},
    bin: {'dsh-toolbox-migrate': './lib/migrate.js'}, engines: source.engines, repository: source.repository,
    files: ['lib/', 'cordis.patch.yml', 'README.md', 'LICENSE', 'notices/', 'assets/', 'THIRD_PARTY_NOTICES.md'],
    peerDependencies: peers, peerDependenciesMeta: Object.fromEntries(Object.keys(peers).map(key => [key,{optional:true}])),
    dependencies: {'@deepseek-ai/schemastery': source.dependencies['@deepseek-ai/schemastery']},
    dsh: {bundle: {patch: 'cordis.patch.yml'}, client: {platform:'web', inject: [...new Set(modules.flatMap(id=>clientDependencies[id]))]}},
  };
  await writeFile(join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyFile(join(root, 'README.md'), join(out, 'README.md'));
  await copyFile(join(root, 'LICENSE'), join(out, 'LICENSE'));
  await mkdir(join(out, 'notices'), {recursive: true});
  for (const id of modules) await copyFile(join(root, 'src/modules', sourceDirectories[id], 'NOTICE.txt'), join(out, 'notices', id + '.txt'));
  if (hasChime) {
    await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));
    await cp(join(root, 'assets'), join(out, 'assets'), {recursive: true});
    // Source sound data is compiled into chime payload; source licenses remain downloadable.
  }
  console.log('Built ' + name + '@' + source.version + ' [' + modules.join(', ') + ']');
}
