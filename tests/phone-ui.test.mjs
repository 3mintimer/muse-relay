// Run against the built phone app in Chrome. All relay traffic stays on the test server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

async function openPhone(t, snapshot = { messages: [], spaces: [] }, settings = {}) {
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 660 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  await page.addInitScript(initial => {
    if (!localStorage.getItem('muse-relay-state-v1')) {
      localStorage.setItem('muse-relay-state-v1', JSON.stringify({ settings: {
        configured: true, language: 'en', relay: 'gadget', relayUrl: location.origin, relayToken: 'test', ...initial
      } }));
    }
  }, settings);
  await page.route('**/v1/snapshot', async route => {
    await route.fulfill({ json: await snapshot });
  });
  const url = 'http://127.0.0.1:' + server.httpServer.address().port;
  await page.goto(url);
  return { page, touch: await page.context().newCDPSession(page) };
}

async function drag(touch, start, end) {
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  // End with small, slow moves so Chrome's touch velocity tracker sees the
  // finger coming to rest before touchEnd on both Linux and macOS.
  for (const fraction of [0.35, 0.65, 0.85, 0.96, 1]) {
    const x = start.x + (end.x - start.x) * fraction;
    const y = start.y + (end.y - start.y) * fraction;
    await new Promise(resolve => setTimeout(resolve, 40));
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  // Pause with the finger down so lifting it ends the drag without a fling.
  await new Promise(resolve => setTimeout(resolve, 180));
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// Locator.tap() scrolls offscreen elements into view. Require a reachable touch
// point first so the browser cannot rescue a broken WebView layout.
async function swipeToControl(touch, control) {
  const positions = [];
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
      const pane = el.closest('.app-scroll');
      if (!pane) return null; // A refresh replaced the control between frames.
      const area = pane.getBoundingClientRect();
      const upper = Math.max(0, area.top), lower = Math.min(visualViewport.height, area.bottom);
      const hit = document.elementFromPoint(x, y);
      const reachable = r.top >= upper && r.bottom <= lower && el.contains(hit);
      return { x, y, upper, lower, reachable, controlHeight: r.height, scrollTop: pane.scrollTop,
        hit: hit && [hit.tagName, hit.className] };
    });
    if (!position) continue;
    const { x, y, upper, lower, reachable } = position;
    if (reachable) return { x, y };
    positions.push(position);
    // Start in the page gutter. An input or slider under the finger can capture
    // a swipe, especially when the keyboard leaves only a short pane.
    const center = (upper + lower) / 2;
    const distance = Math.min((lower - upper) * 0.7, Math.max(40, Math.abs(center - y)));
    const startY = y > center ? center + distance / 2 : center - distance / 2;
    const endY = 2 * center - startY;
    await drag(touch, { x: 6, y: startY }, { x: 6, y: endY });
  }
  assert.fail(`Vertical swipes could not reach ${control}: ${JSON.stringify(positions.slice(-5))}`);
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
  await token.tap();
  await token.fill('test');

  // Model a WebView where only the visual viewport shrinks for the keyboard
  // and swiping the document itself cannot reveal content below the viewport.
  assert.ok(await token.evaluate(el => document.activeElement === el && el.closest('details').open),
    'the keyboard scenario starts with the connection field open and focused');
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

test('importing 16 numbered frames preserves playback order after reload and a failed replacement', async t => {
  const {page}=await openPhone(t,undefined,{images:true});
  const settings=async()=>{
    await page.getByRole('button',{name:'Settings',exact:true}).tap();
    await page.locator('[data-group="avatar"] > summary').tap();
  };
  const assets=page.locator('[data-group="avatar-assets"] > summary');
  await settings();
  await assets.tap();
  await page.getByRole('button',{name:'Ask Muse for animations'}).tap();
  const request = await page.getByRole('textbox',{name:'Request for Muse'}).inputValue();
  assert.match(request, /4 fps/);
  assert.match(request, /one slow body movement for the entire four-second loop/);
  assert.match(request, /At 144×144, compare frames 1 and 9/);
  assert.match(request, /hand should move relative to the hip/);
  assert.match(request, /Do not stretch, squash, shear, zoom or slide the source bitmap/);
  const data=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
    const ctx=canvas.getContext('2d');
    return Array.from({length:16},(_,i)=>{
      ctx.fillStyle='rgb('+[i*17,i*17,i*17].join(',')+')';ctx.fillRect(0,0,16,16);
      return canvas.toDataURL().split(',')[1];
    });
  });
  const files=data.map((base64,i)=>({name:(i+1)+'.png',mimeType:'image/png',buffer:Buffer.from(base64,'base64')})).reverse();
  const choose=async files=>{
    const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'Choose 16 frames'}).first().tap();
    await (await chooser).setFiles(files);
  };
  await choose(files);
  await page.getByText('Saved on device',{exact:true}).waitFor();
  const stored=await page.evaluate(async()=>{
    const key=Object.keys(localStorage).find(k=>k.startsWith('muse-relay-motion-v1:') && k.endsWith(':idle'));
    const img=new Image();img.src='data:image/png;base64,'+localStorage.getItem(key);await img.decode();
    const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    return {size:[img.width,img.height],levels:Array.from({length:16},(_,i)=>ctx.getImageData(i%4*144,Math.floor(i/4)*144,1,1).data[0])};
  });
  assert.deepEqual(stored,{size:[576,576],levels:Array.from({length:16},(_,i)=>i*17)});
  await choose(files.slice(1));
  await page.getByText(/Could not save. Check that you selected 16/).waitFor();
  await page.getByText('Applied · Idle animation', {exact:true}).waitFor();
  await page.getByRole('button',{name:'Hidden',exact:true}).tap();
  await page.getByText('Applied · Hidden', {exact:true}).waitFor();
  await page.reload();await settings();
  assert.equal(await page.getByRole('button',{name:'Hidden',exact:true}).getAttribute('aria-pressed'),'true');
  await assets.tap();
  await page.getByText('Saved on device',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Use images from Muse'}).tap();
  await page.getByRole('button',{name:'Use images from Muse'}).waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('muse-relay-motion-v1:')).length),0);
});

test('avatar selections apply independently, preserve other drafts and survive reopening', { timeout: 30_000 }, async t => {
  const relay = Promise.withResolvers();
  const { page } = await openPhone(t, relay.promise);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 576;
    return canvas.toDataURL().split(',')[1];
  });
  const art = { mime: 'image/png', name: 'test.png', data_base64: png };
  relay.resolve({ messages: [], profile: { avatar: art }, spaces: [{
    id: 'muse_relay_avatar_motion_v1', title: 'Muse', items: ['idle','working'].map(id => ({ id, image: art }))
  }] });
  const settings = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).tap();
    await page.locator('[data-group="avatar"] > summary').tap();
  };
  const applied = mode => page.getByText('Applied · ' + mode, { exact: true });
  const choose = name => page.getByRole('button', { name, exact: true }).tap();
  await settings();
  await applied('Text only').waitFor();
  await choose('Enable images');
  await applied('Idle animation').waitFor();
  await applied('Working animation').waitFor();
  assert.equal(await page.locator('.avatar-thumbnail img.motion-sheet').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Choose 16 frames' }).count(), 0);
  await page.locator('[data-group="display"] > summary').tap();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await choose('Still avatar');
  await applied('Still avatar').waitFor();
  await applied('Working animation').waitFor();
  await choose('Text only');
  await applied('Text only').waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('muse-relay-state-v1')).settings);
  assert.deepEqual([saved.homeAvatar,saved.waitingAvatar,saved.theme,saved.images], ['still','off','system',true]);
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'dark');
  await page.reload(); await settings();
  await applied('Still avatar').waitFor();
  await applied('Text only').waitFor();
  await choose('Hidden'); await applied('Hidden').waitFor();
  await choose('Working animation'); await applied('Working animation').waitFor();
  await choose('Idle animation'); await applied('Idle animation').waitFor();
});
