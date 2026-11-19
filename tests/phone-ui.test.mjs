// Run against the built phone app in Chrome. All relay traffic stays on the test server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

async function openPhone(t, snapshot = { messages: [], spaces: [] }) {
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 660 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    if (!localStorage.getItem('muse-relay-state-v1')) {
      localStorage.setItem('muse-relay-state-v1', JSON.stringify({ settings: {
        configured: true, language: 'en', relay: 'gadget', relayUrl: location.origin, relayToken: 'test'
      } }));
    }
  });
  await page.route('**/v1/snapshot', async route => {
    await route.fulfill({ json: await snapshot });
  });
  const url = 'http://127.0.0.1:' + server.httpServer.address().port;
  await page.goto(url);
  return { page, touch: await page.context().newCDPSession(page) };
}

async function drag(touch, start, end) {
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let i = 1; i <= 5; i++) {
    const x = start.x + (end.x - start.x) * i / 5;
    const y = start.y + (end.y - start.y) * i / 5;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  // Pause with the finger down so lifting it ends the drag without a fling.
  await new Promise(resolve => setTimeout(resolve, 180));
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// Locator.tap() scrolls offscreen elements into view. Require a reachable touch
// point first so the browser cannot rescue a broken WebView layout.
async function swipeToControl(touch, control) {
  let lastPosition;
  for (let i = 0; i < 30; i++) {
    const position = await control.evaluate(async el => {
      // Read hit targets after the compositor has finished the preceding swipe.
      let top;
      do {
        top = el.getBoundingClientRect().top;
        await new Promise(requestAnimationFrame);
      } while (el.getBoundingClientRect().top !== top);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const height = visualViewport.height;
      const reachable = r.top >= 0 && r.bottom <= height &&
        [r.top + 1, y, r.bottom - 1].every(at => el.contains(document.elementFromPoint(x, at)));
      return { x, y, height, reachable, scrollTop: el.closest('.app-scroll')?.scrollTop };
    });
    const { x, y, height, reachable } = position;
    if (reachable) return { x, y };
    lastPosition = position;
    const upper = height * 0.15, lower = height * 0.64;
    const distance = Math.max(upper - lower, Math.min(lower - upper, height * 0.4 - y));
    const start = { x: 26, y: distance < 0 ? lower : upper };
    await drag(touch, start, { x: start.x, y: start.y + distance });
  }
  assert.fail(`Vertical swipes could not reach ${control}: ${JSON.stringify(lastPosition)}`);
}

test('chat history scrolls to the oldest message and back to the composer', { timeout: 30_000 }, async t => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    id: 'test-' + i, from: 'Muse', type: 'text', text: 'Fixture message ' + i, ts: i + 1
  }));
  const { page, touch } = await openPhone(t, { messages, spaces: [] });
  const oldest = page.getByRole('article').filter({ hasText: 'Fixture message 0' });
  const markRead = oldest.getByRole('button', { name: 'Mark read', exact: true });
  await markRead.waitFor();
  const { x, y } = await swipeToControl(touch, markRead);
  await page.touchscreen.tap(x, y);
  await oldest.getByText('Read', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const entry = await swipeToControl(touch, composer);
  await page.touchscreen.tap(entry.x, entry.y);
  assert.ok(await composer.evaluate(field => field === document.activeElement));
});

test('phone settings scroll in both directions with the keyboard open and Save survives a relay refresh', { timeout: 30_000 }, async t => {
  // Hold the first real poll until a finger is on Save.
  const poll = Promise.withResolvers();
  const { page, touch } = await openPhone(t, poll.promise);
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.locator('[data-group="display"] > summary').tap();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.locator('[data-group="connection"] > summary').tap();
  const token = page.getByLabel('Phone access token', { exact: true });
  await token.fill('test');

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
  await swipeToControl(touch, last);
  assert.ok(await last.isEnabled());
  await swipeToControl(touch, token);

  const save = page.getByRole('button', { name: 'Save settings', exact: true });
  const { x, y } = await swipeToControl(touch, save);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/snapshot');
  poll.resolve({ messages: [], spaces: [] });
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByText('Settings saved in this browser.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.locator('[data-group="display"] > summary').tap();
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'dark');
});

test('swiping the head-angle chart scrolls the page and dragging the marker adjusts the angle', { timeout: 30_000 }, async t => {
  const { page, touch } = await openPhone(t);
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.locator('[data-group="head-wake"] > summary').tap();
  await page.getByLabel('Raise head to wake', { exact: true }).check();
  const chart = page.getByRole('slider', { name: 'Head-up display' });
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  const start = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.7 };
  const angle = await chart.getAttribute('aria-valuenow');
  const before = await page.locator('.app-scroll').evaluate(el => el.scrollTop);
  await drag(touch, start, { x: start.x, y: start.y - 90 });
  await page.waitForFunction(top => document.querySelector('.app-scroll').scrollTop > top + 20, before, { timeout: 5000 });
  assert.equal(await chart.getAttribute('aria-valuenow'), angle);

  const handle = chart.locator('.angle-handle');
  await handle.scrollIntoViewIfNeeded();
  const marker = await handle.boundingBox();
  const center = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  await drag(touch, center, { x: center.x - 20, y: center.y - 35 });
  assert.ok(Number(await chart.getAttribute('aria-valuenow')) > Number(angle));
});
