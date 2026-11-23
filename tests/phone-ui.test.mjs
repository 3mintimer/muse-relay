// Run against the built phone app in Chrome. All relay traffic stays on the test server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
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
    if (new URL(route.request().url()).pathname !== '/v1/snapshot') return route.continue();
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
  const first = ['Go ahead','Check the budget','Skip this plan'];
  const second = ['Use that budget','Review transport','Decide later'];
  Object.assign(messages[3], {from:'You'});
  Object.assign(messages[4], {reply_to:messages[3].id, reply_suggestions:first});
  Object.assign(messages[5], {from:'You', text:first[1]});
  Object.assign(messages[6], {reply_to:messages[5].id, reply_suggestions:second});
  Object.assign(messages[7], {from:'You', text:second[0]});
  const { page, touch } = await openPhone(t, { messages, spaces: [], capabilities:{reply_suggestions:true} }, {suggestionMode:'auto'});
  const oldest = page.getByRole('article').filter({ hasText: 'Fixture message 0' });
  const markRead = oldest.getByRole('button', { name: 'Mark read', exact: true });
  await markRead.waitFor();
  for (const chosen of [first[1], second[0]]) assert.equal(await page.getByText(chosen, {exact:true}).count(), 1);
  for (const unused of [first[0], first[2], second[1], second[2]]) assert.equal(await page.getByText(unused, {exact:true}).count(), 0);
  const { x, y } = await swipeToControl(touch, markRead);
  await page.touchscreen.tap(x, y);
  await oldest.getByText('Read', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const entry = await swipeToControl(touch, composer);
  await page.touchscreen.tap(entry.x, entry.y);
  assert.ok(await composer.evaluate(field => field === document.activeElement));
});

for (const [mode, theme] of [['gadget', 'dark'], ['custom', 'light'], ['custom', 'dark']]) {
  test(`${mode} settings scroll with the keyboard open and Save survives a relay refresh (${theme})`, { timeout: 30_000 }, async t => {
    // Hold the first real poll until a finger is on Save.
    const poll = Promise.withResolvers();
    const { page, touch } = await openPhone(t, poll.promise, { relay: mode, customRelayUrl: 'http://127.0.0.1', customRelayToken: 'test' });
    await page.getByRole('button', { name: 'Settings', exact: true }).tap();
    await page.locator('[data-group="display"] > summary').tap();
    await page.getByLabel('Theme', { exact: true }).selectOption(theme);
    await page.locator('[data-group="connection"] > summary').tap();
    const token = page.getByLabel(mode === 'custom' ? 'Phone access token (optional)' : 'Phone access token', { exact: true });
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
    assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), theme);
  });
}

test('custom setup checks the snapshot and exchanges chat over an anonymous HTTP subpath', { timeout: 45_000 }, async t => {
  const calls = [];
  const messages = [];
  const relay = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, OAI-Sites-Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    calls.push({ path: req.url, auth: req.headers.authorization, hosting: req.headers['oai-sites-authorization'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/locked/v1/snapshot') { res.writeHead(401).end('{}'); return; }
    if (req.url === '/invalid/v1/snapshot') { res.end('{}'); return; }
    if (req.url === '/muse/v1/snapshot') { res.end(JSON.stringify({ messages })); return; }
    if (req.url === '/muse/v1/requests' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks));
      messages.push({ id: 'muse_example', from: 'Muse', type: 'text', text: 'Reply to ' + request.text, ts: request.created_at + 1, reply_to: request.id });
      res.writeHead(202).end(JSON.stringify({ accepted: true, id: request.id })); return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });
  const base = 'http://127.0.0.1:' + relay.address().port;
  const { page } = await openPhone(t, { messages: [] }, { configured: false });
  await page.locator('input[value="custom"]').check();
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.tap();
  const url = page.getByLabel('Base URL', { exact: true });
  const check = page.getByRole('button', { name: 'Check connection', exact: true });
  const save = page.getByRole('button', { name: 'Save and open', exact: true });
  const back = page.getByRole('button', { name: 'Back', exact: true });
  for (const [path, error] of [['/locked', 'HTTP 401'], ['/invalid', 'Relay messages missing'], ['/muse/', null]]) {
    await url.fill(base + path);
    assert.equal(await page.getByLabel('Phone access token (optional)', { exact: true }).inputValue(), '');
    await next.tap(); await next.tap(); await check.tap();
    if (error) {
      await page.getByRole('alert').filter({ hasText: error }).first().waitFor();
      assert.ok(await save.isDisabled());
      await back.tap(); await back.tap();
    }
  }
  await save.tap();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('custom chat');
  await page.getByRole('button', { name: 'Send', exact: true }).tap();
  await page.getByText('Reply to custom chat', { exact: true }).waitFor();
  assert.equal(calls.filter(call => call.path === '/muse/v1/requests').length, 1);
  assert.ok(calls.every(call => call.auth === undefined && call.hosting === undefined));
  await page.reload();
  await page.getByText('Custom relay server connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.locator('[data-group="connection"] > summary').tap();
  assert.equal(await url.inputValue(), base + '/muse');
  await page.locator('input[value="gadget"]').check();
  const gadgetUrl = page.getByLabel('Relay server URL', { exact: true });
  assert.equal(await gadgetUrl.inputValue(), new URL(page.url()).origin);
  assert.equal(await page.getByLabel('Phone access token', { exact: true }).inputValue(), 'test');
  await check.tap();
  await page.getByRole('button', { name: 'Save settings', exact: true }).tap();
  await page.getByRole('button', { name: 'Chat', exact: true }).tap();
  await page.getByText('No messages yet', { exact: true }).waitFor();
  assert.equal(await page.getByText('Reply to custom chat', { exact: true }).count(), 0);
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

test('chat and settings share one persisted location switch and preserve a typed draft', async t => {
  const { page } = await openPhone(t, { messages: [], spaces: [], capabilities:{images:true} }, {language:'en',images:true});
  const location = page.getByRole('button', {name:'Location',exact:true});
  await location.waitFor();
  assert.equal(await location.getAttribute('aria-pressed'), 'false');
  await page.getByRole('textbox', {name:'Message',exact:true}).fill('Draft to keep');
  await location.tap();
  await page.locator('.composer [aria-pressed="true"]').waitFor();
  assert.equal(await page.getByRole('textbox', {name:'Message',exact:true}).inputValue(), 'Draft to keep');
  await page.reload();
  await page.locator('.composer [aria-pressed="true"]').waitFor();
  await page.getByRole('button', {name:'Settings',exact:true}).tap();
  await page.locator('[data-group="location"] > summary').tap();
  const setting = page.getByRole('switch', {name:/Share location with relay/});
  assert.equal(await setting.isChecked(), true);
  await setting.uncheck();
  await page.getByRole('button', {name:'Save settings',exact:true}).tap();
  await page.reload();
  await page.locator('.composer').waitFor();
  assert.equal(await location.getAttribute('aria-pressed'), 'false');
});

test('sent pins reveal only their own saved fix after a refresh and reload', async t => {
  const messages = ['First', 'Second', 'No fix'].map((text, i) => ({id: 'sent-' + i, from: 'You', type: 'text', text, ts: 600 + i}));
  const fixes = [{latitude:12.125, longitude:-34.875, captured_at:560, accuracy:18}, {latitude:43.625, longitude:0, captured_at:590}];
  const echo = {id:'reply',reply_to:'sent-0',from:'Muse',type:'text',text:'At 12.125, -34.875.',ts:604};
  const {page} = await openPhone(t, {messages:[...messages,echo], spaces:[]}, {theme:'dark'});
  await page.addInitScript(({messages, fixes}) => {
    if (sessionStorage.getItem('seeded-fixes')) return;
    sessionStorage.setItem('seeded-fixes', '1');
    const state = JSON.parse(localStorage.getItem('muse-relay-state-v1'));
    localStorage.setItem('muse-relay-cache-v1', JSON.stringify({savedAt:state.savedAt || 0, snapshot:{
      messages:messages.map((m, i) => ({...m, sentLocation:fixes[i]})), spaces:[]
    }}));
  }, {messages, fixes});
  await page.reload();
  const pin = (name) => page.getByRole('article').filter({hasText:name}).getByRole('button', {name:'Sent location',exact:true});
  await pin('First').waitFor();
  await page.getByRole('button',{name:'Refresh',exact:true}).tap();
  await page.getByText('At Location.', {exact:true}).waitFor();
  for (const [i, name] of ['First','Second'].entries()) {
    assert.doesNotMatch(await page.locator('body').innerText(), /12\.125|43\.625/);
    assert.equal(await pin(name).innerText(), '');
    await pin(name).tap();
    const dialog = page.getByRole('dialog',{name:'Sent location'});
    await dialog.getByText(String(fixes[i].latitude),{exact:true}).waitFor();
    assert.equal(await dialog.getByText(String(fixes[i].longitude),{exact:true}).count(), 1);
    assert.equal(await dialog.getByText('Location accuracy',{exact:true}).count(), i === 0 ? 1 : 0);
    await dialog.getByRole('button',{name:'Close'}).tap();
    assert.equal(await pin(name).evaluate(el=>el===document.activeElement),true);
  }
  assert.equal(await pin('No fix').count(),0);
  assert.equal(await page.getByRole('button',{name:'Location',exact:true}).innerText(),'');
  await page.reload();
  await pin('First').waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /12\.125|43\.625/);
});

test('three saved prompts send from the composer and Usage isolates the matching reply', async t => {
  const snapshot = { messages: [{id:'other',from:'Muse',type:'text',text:'Unrelated conversation',ts:1}], spaces:[] };
  const { page } = await openPhone(t,snapshot);
  const sent = [];
  await page.route('**/v1/requests', async route => {
    const req = route.request().postDataJSON();
    sent.push(req);
    if (req.text === 'Show /subscription-status concisely.') {
      snapshot.messages.push({id:'answer',from:'Muse',type:'text',text:'Demo plan · 20 tokens',ts:2,reply_to:req.id});
    }
    await route.fulfill({json:{}});
  });
  const nav = page.getByRole('navigation');
  await nav.waitFor();
  assert.deepEqual(await nav.getByRole('button').allTextContents(), ['Chat','Spaces','Shortcuts','Settings']);
  await nav.getByRole('button',{name:'Shortcuts'}).tap();
  const values = ['Summarize today','First line\nSecond line','Plan tomorrow'];
  for (const [i,value] of values.entries()) await page.getByLabel('Prompt '+(i+1), {exact:true}).fill(value);
  await page.getByRole('button',{name:'Save prompts',exact:true}).tap();
  await page.getByText('Settings saved in this browser.',{exact:true}).waitFor();
  assert.equal(sent.length,0,'editing prompts must not send a usage request');
  await page.reload();
  const draft = page.getByRole('textbox',{name:'Message',exact:true});
  await draft.fill('Unsent draft');
  const shortcuts = page.locator('.saved-prompt-buttons button');
  assert.equal(await shortcuts.count(),3);
  for (const [i,value] of values.entries()) {
    const accepted = page.waitForResponse(r=>r.url().endsWith('/v1/requests'));
    await shortcuts.nth(i).tap(); await accepted;
    assert.equal(sent.at(-1).text,value);
    assert.equal(await draft.inputValue(),'Unsent draft');
  }
  await nav.getByRole('button',{name:'Shortcuts'}).tap();
  await page.getByRole('button',{name:'Check usage',exact:true}).tap();
  await page.getByText('Demo plan · 20 tokens',{exact:true}).waitFor();
  assert.equal(await page.getByText('Unrelated conversation').count(),0);
  await nav.getByRole('button',{name:'Chat'}).tap();
  await page.getByText('Unrelated conversation',{exact:true}).waitFor();
  assert.equal(await page.getByText('Demo plan · 20 tokens').count(),0);
});
