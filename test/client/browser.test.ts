import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const testDeps = process.env.DSH_TOOLBOX_TEST_DEPS;
const dependency = createRequire(testDeps ? join(testDeps, 'package.json') : new URL('../../package.json', import.meta.url));
async function bundle(descriptor: any) {
  const hasChime = descriptor.moduleIds.includes('chime');
  const contents = 'import {createToolboxClient} from "./client/index.ts";\n' + (hasChime ? 'import {createChimeAdapter} from "./client/chime.ts";\n' : '') + 'window.__ModuleLoader__.load({id:' + JSON.stringify(descriptor.packageName) + ',factory(require){return createToolboxClient(' + JSON.stringify(descriptor) + ',require("react")' + (hasChime ? ',createChimeAdapter' : '') + ');}});';
  return (await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0]!.text;
}

test('Chromium emitted client: rendered settings, rest persistence, audio, disable, and fresh-page handover', { timeout: 60000 }, async () => {
  const descriptor = { rowId: 'dsh-toolbox', packageName: 'dsh-toolbox', moduleIds: ['context','retry','chime','goalWait'] };
  const plugin = await bundle(descriptor);
  const harness = (await build({ entryPoints: [join(root, 'test/client/browser-harness.fixture.js')], bundle: true, write: false, platform: 'browser', format: 'iife', alias: { react: dependency.resolve('react'), 'react-dom/client': dependency.resolve('react-dom/client') } })).outputFiles[0]!.text;
  let reloadAfter: number | undefined;
  let legacy = false;
  let hostAvailable = true;
  const server = createServer((req, res) => {
    if (req.url === '/plugin.js') { res.setHeader('content-type','text/javascript'); res.end(plugin); return; }
    if (req.url === '/harness.js') { res.setHeader('content-type','text/javascript'); res.end(harness); return; }
    if (req.url === '/toolbox/dsh-toolbox/status') {
      res.setHeader('content-type','application/json');
      if (!hostAvailable) { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ modules: Object.fromEntries(descriptor.moduleIds.map(id => [id,{phase:'active',ready:true,enabled:true}])), report: { browserReloadAfter: reloadAfter } })); return;
    }
    res.setHeader('content-type','text/html');
    res.end('<div id="root"></div><script>window.descriptor=' + JSON.stringify(descriptor) + ';window.__DSH_BOOT__={entries:' + JSON.stringify(legacy ? [{id:'dsh-session-chime'}] : []) + '};window.__DSH_TOOLBOX_PAGE_dsh_toolbox__={servedAt:' + Date.now() + '};</script><script src="/harness.js"></script><script src="/plugin.js"></script>');
  });
  server.listen(0,'127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = 'http://127.0.0.1:' + address.port;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TOOLBOX_CHROMIUM, args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => document.querySelector('[aria-pressed]'));
    assert.equal(await page.locator('[data-module]').count(), 4);
    assert.equal(await page.locator('[data-package="dsh-toolbox"]').count(), 1);
    await page.getByRole('button', { name: '🔔 正常', exact: true }).click();
    await page.waitForFunction(() => (window as any).accepted().modules.chime.restMode === true);
    await page.reload(); await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]'));
    await page.getByRole('button', { name: '🌙 休息中', exact: true }).click();
    await page.evaluate(() => { (window as any).setRunning(true); (window as any).setRunning(false); });
    await page.waitForFunction(() => (window as any).starts === 1);
    await page.getByRole('button', { name: '停止铃声', exact: true }).click();
    await page.evaluate(() => (window as any).disableChime());
    await page.waitForFunction(() => !document.querySelector('[aria-pressed]'));
    assert.equal(await page.locator('[data-module]').count(), 4, 'sibling settings remain after disabling chime');
    assert.deepEqual(errors, []);

    // A stale page that loaded legacy remains silent even after server status is ready.
    legacy = true; await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.waitForFunction(() => document.body.textContent?.includes('reload-required'));
    assert.equal(await page.locator('[aria-pressed]').count(), 0);
    await page.evaluate(() => { (window as any).setRunning(true); (window as any).setRunning(false); });
    assert.equal(await page.evaluate(() => (window as any).starts), 0);
    legacy = false; reloadAfter = Date.now();
    const fresh = await browser.newPage(); await fresh.goto(url);
    await fresh.waitForFunction(() => document.querySelector('[aria-pressed]'));
    await fresh.evaluate(() => { (window as any).setRunning(true); (window as any).setRunning(false); });
    await fresh.waitForFunction(() => (window as any).starts === 1);
    assert.equal(await page.locator('[aria-pressed]').count(), 0, 'another stale tab is not rearmed');
    hostAvailable = false;
    await fresh.waitForFunction(() => !document.querySelector('[aria-pressed]'));
    assert.equal(await fresh.locator('[data-module]').count(), 4);
    await fresh.evaluate(() => (window as any).unload()); await page.evaluate(() => (window as any).unload());
    await page.close(); await fresh.close();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); server.close(); await once(server, 'close'); }
});
