// Run against the built phone app in Chrome. All relay traffic stays on the test server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

test('settings can be scrolled and saved while editing and receiving a snapshot', { timeout: 30_000 }, async t => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 660 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => {
    if (!localStorage.getItem('muse-relay-state-v1')) {
      localStorage.setItem('muse-relay-state-v1', JSON.stringify({ settings: {
        configured: true, language: 'en', relay: 'gadget', relayUrl: location.origin, relayToken: 'test'
      } }));
    }
  });
  // Hold the first real poll until a finger is on Save.
  const poll = Promise.withResolvers();
  await page.route('**/v1/snapshot', async route => {
    await poll.promise;
    await route.fulfill({ json: { messages: [], spaces: [] } });
  });
  const url = 'http://127.0.0.1:' + server.httpServer.address().port;
  await page.goto(url);
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.locator('[data-group="display"] > summary').tap();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.locator('[data-group="connection"] > summary').tap();
  await page.getByLabel('Phone access token', { exact: true }).fill('test');

  // Model a WebView where only the visual viewport shrinks for the keyboard
  // and swiping the document itself cannot reveal content below the viewport.
  await page.evaluate(() => {
    for (const element of [document.documentElement, document.body]) {
      element.style.height = '100%';
      element.style.overflow = 'hidden';
    }
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 320 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  const last = page.getByRole('button', { name: 'Remove saved connection details' });
  await page.mouse.move(70, 190);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 580);
  await page.waitForFunction(() => {
    const button = document.querySelector('.settings-content > .danger-button');
    const bounds = button.getBoundingClientRect();
    return bounds.bottom <= visualViewport.height && button.contains(document.elementFromPoint(bounds.x + 20, bounds.y + 20));
  });
  assert.equal(await last.isEnabled(), true);

  const save = page.getByRole('button', { name: 'Save settings', exact: true });
  await save.scrollIntoViewIfNeeded();
  const bounds = await save.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  assert.ok(y > 0 && y < 320);
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/snapshot');
  poll.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByText('Settings saved in this browser.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.locator('[data-group="display"] > summary').tap();
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'dark');
});
