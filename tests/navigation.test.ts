import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getTextWidth } from '@evenrealities/pretext';
import { ImageRawDataUpdateResult, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { createController } from '../src/core/controller.ts';
import { defaults } from '../src/core/config.ts';
import { Glasses, glassBodyRows } from '../src/core/glasses.ts';
import { G2_LINE_HEIGHT, lineBudget, wrapLines } from '../src/core/glass-text.ts';
import { locales } from '../src/core/i18n.ts';
import type { AppState, RelayRequest, Settings, Snapshot } from '../src/core/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fixture = (): Snapshot => ({
  messages: [{ id: 'test-message', from: 'Muse', type: 'text', text: 'テストの返信', ts: 1 }],
  spaces: [{ id: 'test-space', title: 'テストスペース', layout:'cards', items: [{ id: 'test-card', title: 'テストカード', text: 'テストカードの本文' }] }],
});
const response = (value: Snapshot) => new Response(JSON.stringify(value), { status: 200 });
const interactiveFixture=():Snapshot=>({messages:[],spaces:[{id:'test-space',title:'操作',layout:'list',items:[
  {id:'read',title:'予定',text:'予定の本文'},
  {id:'run',title:'要約',text:'',control:{type:'button'}},
  {id:'slider',title:'集中時間',text:'',control:{type:'slider',min:5,max:60,step:5,value:25,unit:'分'}},
  {id:'choice',title:'長さ',text:'',control:{type:'choice',value:'short',options:[{id:'short',title:'短く'},{id:'full',title:'詳しく'}]}},
  {id:'mic',title:'メモ',text:'',control:{type:'microphone'}},
]}]});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const chatStamp = (ts:number) => new Date(ts*1000).toLocaleString('ja',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(check(), label);
}

function fakeDisplay() {
  let page: Record<string, any> = {};
  let eventHandler: ((event: EvenHubEvent) => void) | undefined;
  const frames: string[] = [], operations: string[] = [];
  const text = () => (page.textObject || []).map((item: any) => item.content || '').join('\n');
  const items = () => (page.listObject || []).flatMap((item: any) => item.itemContainer?.itemName || []);
  const recordFrame = () => frames.push(text());
  const bridge = {
    onEvenHubEvent(callback: (event: EvenHubEvent) => void) { eventHandler = callback; return () => { eventHandler = undefined; }; },
    async getLocalStorage() { return ''; },
    async setLocalStorage(_key: string, _value: string) { return true; },
    async createStartUpPageContainer(value: Record<string, any>) { page = structuredClone(value); recordFrame(); return 0; },
    async rebuildPageContainer(value: Record<string, any>) {
      operations.push(value.listObject?.length ? 'rebuild:list' : 'rebuild:text');
      page = structuredClone(value); recordFrame(); return true;
    },
    async textContainerUpgrade(value: Record<string, any>) {
      const target = page.textObject?.find((item: any) => item.containerID === value.containerID && item.containerName === value.containerName);
      operations.push(target ? 'upgrade:valid' : 'upgrade:missing');
      if (!target) return false;
      target.content = value.content;if(value.textColor!==undefined)target.textColor=value.textColor;recordFrame(); return true;
    },
    async updateImageRawData(_value: unknown) { operations.push('image');return ImageRawDataUpdateResult.success; },
    async audioControl(_open = false) { return true; },
    async shutDownPageContainer() { return true; },
  };
  return { bridge, frames, operations, text, items, containers:()=>structuredClone(page.textObject||[]), emit: (event: unknown) => eventHandler?.(event as EvenHubEvent) };
}

function bodyGeometry(app:ReturnType<typeof fakeDisplay>){
  const containers=app.containers(),body=containers.find((c:any)=>c.containerName==='body');
  const input=containers.find((c:any)=>c.containerName==='input'),footer=containers.find((c:any)=>c.containerName==='footer');
  assert.ok(body,'a text page has a body');
  const rows=lineBudget(body.height,body);
  assert.equal(rows,glassBodyRows(footer?.content||'',input?.content));
  assert.ok(wrapLines(body.content,body.width).length<=rows,'every body line fits its actual container');
  assert.equal(body.yPosition,input?.height||0);
  assert.equal(body.height+(input?.height||0)+(footer?.height||0),288,'the body uses all remaining height');
  return {body,input,footer,rows};
}

async function appFixture(t: TestContext, snapshot = fixture(), virtualTime: boolean|number = false, settings:Partial<Settings>={}) {
  const display = fakeDisplay();
  const cleanups:Array<()=>void>=[];
  const saved = JSON.stringify({ settings: { ...defaults, language: 'ja', relay: 'gadget', relayUrl: 'https://relay.example.test',
    relayToken: 'synthetic-navigation-test', configured: true, pollSeconds: 300, images: true,...settings }, snapshot,
    readIds: [], hiddenIds: [], selectedSpaceIds: ['test-space'] });
  display.bridge.getLocalStorage = async () => saved;
  const windowTarget = Object.assign(new EventTarget(), { flutter_inappwebview: {} });
  const documentTarget = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} } });
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => values.delete(key) };
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const requests: RequestInit[] = [];
  const sent: RelayRequest[] = [];
  let nextSend = async () => new Response('{}', { status: 200 });
  let nextRead: (options: RequestInit) => Promise<Response> = async () => response(snapshot);
  let nextSonioxKey: (options: RequestInit) => Promise<Response> = async () => Response.json({api_key:'snx_temp_synthetic'});
  let readAttachment = async () => new Response('{}', {status:503});
  let attachmentReads = 0;
  install('window', windowTarget); install('document', documentTarget);
  install('localStorage', memory()); install('sessionStorage', memory());
  install('fetch', async (input: string | URL | Request, options: RequestInit = {}) => {
    if(String(input)==='https://api.github.com/gists/0123456789abcdef0123456789abcdef'){
      if(options.method==='PATCH'){
        const files=JSON.parse(String(options.body)).files;
        const name=Object.keys(files).find(name=>name.startsWith('muse-relay-request-'))!;
        sent.push(JSON.parse(files[name].content));return nextSend();
      }
      requests.push(options);const result=await nextRead(options);
      return result.ok?Response.json({files:{'g2muse-relay.json':{content:JSON.stringify(await result.json())}}}):result;
    }
    if(String(input)==='https://relay.example.test/v1/soniox-token')return nextSonioxKey(options);
    if(String(input)==='https://relay.example.test/v1/requests'){sent.push(JSON.parse(String(options.body)));return nextSend();}
    if(String(input).startsWith('https://relay.example.test/v1/files/')){attachmentReads++;return readAttachment();}
    assert.equal(String(input), 'https://relay.example.test/v1/snapshot', 'tests must never use a real network endpoint');
    requests.push(options); return nextRead(options);
  });
  if(virtualTime)t.mock.timers.enable({apis:['setTimeout','Date'],now:typeof virtualTime==='number'?virtualTime:10000});
  const controller = createController({ bridgeFactory: async () => display.bridge as unknown as EvenAppBridge });
  t.after(async () => {
    documentTarget.hidden = true; documentTarget.dispatchEvent(new Event('visibilitychange'));
    display.emit({ sysEvent: { eventType: 7 } }); windowTarget.dispatchEvent(new Event('pagehide'));
    for(const cleanup of cleanups)cleanup();
    await settle();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const ready=()=>controller.state.connected&&display.items().includes('チャット');
  if(virtualTime){
    for(let step=0;step<20&&!ready();step++){t.mock.timers.tick(0);await settle();}
    assert.ok(ready(),'the restored app should open its root list');
  }else await until(ready, 'the restored app should open its root list');
  await settle();
  return {
    ...display, controller, requests, sent, document: documentTarget,
    onCleanup:(callback:()=>void)=>{cleanups.push(callback);},
    setSend: (handler: () => Promise<Response>) => { nextSend = handler; },
    setRead: (handler: (options: RequestInit) => Promise<Response>) => { nextRead = handler; },
    setSonioxKey: (handler: (options: RequestInit) => Promise<Response>) => { nextSonioxKey = handler; },
    setAttachment: (handler: () => Promise<Response>) => { readAttachment = handler; },
    attachmentReads: () => attachmentReads,
    overlay: (id?: number) => {
      display.emit({ sysEvent: { eventType: 4 } });
      if (id !== undefined) display.emit({ menuItemClickEvent: { itemID: id } });
      display.emit({ sysEvent: { eventType: 5 } });
    },
  };
}

test('registered spaces keep user order through refresh, persist removals, and can be added again',async t=>{
  const snapshot=fixture();snapshot.spaces.push({...snapshot.spaces[0]!,id:'second',title:'Second'});
  const app=await appFixture(t,snapshot,true);let saved='';
  app.bridge.setLocalStorage=async(_key,value)=>{saved=value;return true;};
  await app.controller.selectSpaces(['second','test-space','second']);
  app.overlay(5);await settle();assert.deepEqual(app.items(),['Second',snapshot.spaces[0]!.title]);
  await app.controller.refresh();assert.deepEqual(app.items(),['Second',snapshot.spaces[0]!.title]);
  await app.controller.showSpace('second');await app.controller.selectSpaces(['test-space']);
  assert.deepEqual(app.items(),[snapshot.spaces[0]!.title]);
  assert.deepEqual(JSON.parse(saved).selectedSpaceIds,['test-space']);
  await app.controller.refresh();assert.equal(app.controller.state.snapshot.spaces.length,2,'unregistering does not delete Muse exports');
  assert.deepEqual(app.controller.state.selectedSpaceIds,['test-space']);
  await app.controller.selectSpaces(['test-space','second']);assert.deepEqual(app.items(),[snapshot.spaces[0]!.title,'Second']);
});

test('an unavailable avatar keeps the home menu usable and retries with backoff or explicit refresh',async t=>{
  const snapshot=fixture(),app=await appFixture(t,snapshot,true);
  snapshot.profile={name:'Test Muse',avatar_file:'avatar.png',mime_type:'image/png',updated_at:1};
  await app.controller.refresh();await settle();
  assert.equal(app.controller.state.avatarStatus,'error');assert.deepEqual(app.items(),['チャット','スペース','録音を開始']);
  const attempts=app.attachmentReads();t.mock.timers.tick(10000);await settle();assert.equal(app.attachmentReads(),attempts,'a failed job must not loop');
  t.mock.timers.tick(290000);await settle();assert.equal(app.attachmentReads(),attempts+1,'periodic refresh retries a transient download failure');
  await app.controller.refresh();await settle();assert.equal(app.attachmentReads(),attempts+2);
  await app.controller.saveSettings({...app.controller.state.settings,images:false});assert.equal(app.controller.state.avatarStatus,'none');
});

test('home clock rolls over at midnight without rebuilding the menu or delaying auto-hide and stops offscreen',async t=>{
  const app=await appFixture(t,fixture(),new Date(2026,10,17,23,59,55).getTime());
  const header=()=>app.containers().find((c:any)=>c.containerName==='header');
  assert.match(header().content,/2026\/11\/17.*23:59/);assert.equal(header().textColor,4);
  assert.deepEqual(app.items(),['チャット','スペース','録音を開始']);
  await app.controller.saveSettings({...app.controller.state.settings,autoHideSeconds:10});
  const rebuilds=app.operations.filter(op=>op==='rebuild:list').length;
  app.document.hidden=true;app.document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(5000);await settle();
  assert.match(header().content,/2026\/11\/18.*00:00/);
  assert.equal(app.operations.filter(op=>op==='rebuild:list').length,rebuilds,'clock updates must preserve native menu selection');
  t.mock.timers.tick(5000);await settle();assert.equal(app.controller.state.displaySleeping,true,'clock ticks do not extend auto-hide');
  assert.equal(app.text().trim(),'');let frames=app.frames.length;
  t.mock.timers.tick(60000);await settle();assert.equal(app.frames.length,frames,'hidden display stays empty');
  await app.controller.saveSettings({...app.controller.state.settings,autoHideSeconds:0});
  await app.controller.restoreDisplay();assert.match(header().content,/00:01/);
  app.emit({sysEvent:{eventType:4}});frames=app.frames.length;
  t.mock.timers.tick(60000);await settle();assert.equal(app.frames.length,frames,'clock pauses for the contextual overlay');
  app.emit({sysEvent:{eventType:5}});await settle();assert.match(header().content,/00:02/);
  app.emit({listEvent:{currentSelectItemIndex:0}});await settle();assert.equal(header(),undefined);
  frames=app.frames.length;t.mock.timers.tick(60000);await settle();assert.equal(app.frames.length,frames,'chat has no clock updates');
  await app.controller.showGlassesMenu();assert.match(header().content,/00:03/);
  app.emit({sysEvent:{eventType:7}});frames=app.frames.length;
  t.mock.timers.tick(60000);await settle();assert.equal(app.frames.length,frames,'exit stops the clock');
});

test('paired chat keeps input dim, replies and UI bright, and preserves paging, hidden state and single-message access',async t=>{
  const snapshot=fixture();
  snapshot.messages=[{id:'ask',from:'You',type:'text',text:'質問の本文'.repeat(30),ts:1},
    {id:'reply',from:'Muse',type:'text',text:Array.from({length:14},(_,i)=>`回答 ${i+1}`).join('\n'),reply_to:'ask',ts:2},
    {id:'ask2',from:'You',type:'text',text:'次の質問',ts:3},
    {id:'reply2',from:'Muse',type:'text',text:'次の回答',reply_to:'ask2',ts:4}];
  const app=await appFixture(t,snapshot,true);
  await app.controller.showMessage('reply');
  const part=(name:string)=>app.containers().find((c:any)=>c.containerName===name);
  assert.equal(part('input').textColor,1);assert.equal(part('body').textColor,4);assert.equal(part('footer').textColor,4);
  assert.match(part('input').content,/あなた:.*質問/s);assert.match(part('input').content,/…$/);
  assert.ok(part('input').content.startsWith(`あなた: ${chatStamp(1)} · `));
  assert.equal(wrapLines(part('input').content).length,2);assert.equal(part('input').height,2*G2_LINE_HEIGHT);
  const longInputBodyHeight=bodyGeometry(app).body.height;
  assert.match(part('footer').content,/タップ: 次のページ · 2回: ホーム/);
  const question=part('input').content,first=part('body').content,total=Number(part('footer').content.match(/^\d+\/(\d+)/)![1]),read=[first];
  for(let index=1;index<total;index++){
    app.emit({sysEvent:{}});await settle();assert.equal(part('input').content,question);
    read.push(bodyGeometry(app).body.content);
  }
  assert.equal(read.join('\n'),wrapLines(`Muse: ${snapshot.messages[1]!.text}`).join('\n'),'paging keeps every reply line');
  assert.doesNotMatch(part('footer').content,/次のページ/,'the final page must not advertise a nonexistent next page');
  assert.match(part('footer').content,/2回タップ: ホーム/);
  app.emit({sysEvent:{}});await settle();assert.equal(part('body').content,first,'the existing final-page wrap is preserved');
  app.emit({textEvent:{eventType:1}});await settle();assert.match(part('body').content,/次の回答/);
  assert.equal(part('input').content,`あなた: ${chatStamp(3)} · 次の質問`);
  assert.equal(part('input').height,G2_LINE_HEIGHT);assert.ok(bodyGeometry(app).body.height>longInputBodyHeight);
  assert.doesNotMatch(part('footer').content,/次のページ/,'a one-page answer only shows the home gesture');
  app.overlay(11);await settle();assert.equal(app.controller.state.settings.chatLayout,'single');assert.equal(part('input'),undefined);
  app.emit({textEvent:{eventType:2}});await settle();assert.match(app.text(),/次の質問/);assert.equal(part('body').textColor,1);
  await app.controller.showSpace('test-space');assert.equal(part('body').textColor,4,'brightness must reset when a dim container is reused for UI');
  await app.controller.saveSettings({...app.controller.state.settings,chatLayout:'exchange',autoHideSeconds:5});
  await app.controller.showMessage('reply');t.mock.timers.tick(5000);await settle();
  assert.equal(app.text().trim(),'');assert.equal(part('input'),undefined,'auto-hide removes both chat panes');
  await app.controller.restoreDisplay();assert.equal(part('input').textColor,1);assert.equal(part('body').textColor,4);
});

test('G2 chat uses the original input time for a transcript and the latest message time for a standalone reply',async t=>{
  const snapshot=fixture();
  snapshot.messages=[
    {id:'ask',from:'You',type:'voice-note',text:'',ts:60},
    {id:'transcript',from:'You',type:'text',text:'音声の質問',reply_to:'ask',ts:120},
    {id:'reply',from:'Muse',type:'text',text:'回答',reply_to:'ask',ts:180},
    {id:'standalone',from:'Muse',type:'text',text:'単独の回答',ts:240},
  ];
  const app=await appFixture(t,snapshot);
  await app.controller.showMessage('reply');
  let frame=bodyGeometry(app);
  assert.equal(frame.input.content,`あなた: ${chatStamp(60)} · 音声の質問`);
  assert.equal(frame.body.content,'Muse: 回答');
  await app.controller.showMessage('standalone');
  frame=bodyGeometry(app);
  assert.equal(frame.input,undefined);
  assert.equal(frame.body.content,`Muse · ${chatStamp(240)}\n単独の回答`);
  snapshot.messages[3]!.ts=300;
  await app.controller.refresh();
  assert.equal(bodyGeometry(app).body.content,`Muse · ${chatStamp(300)}\n単独の回答`);
});

test('all display languages page the complete reply using the actual input and footer geometry',async t=>{
  const snapshot=fixture(),reply=Array.from({length:96},(_,i)=>`Line ${String(i+1).padStart(3,'0')}`).join('\n');
  snapshot.messages=[{id:'ask',from:'You',type:'text',text:'Short input',ts:1},
    {id:'reply',from:'Muse',type:'text',text:reply,reply_to:'ask',ts:2}];
  const app=await appFixture(t,snapshot);
  for(const [index,locale] of locales.entries()){
    const long=index%2===1;
    app.controller.state.snapshot.messages.find(m=>m.id==='ask')!.text=long?'A longer input '.repeat(30):'Short input';
    await app.controller.saveSettings({...app.controller.state.settings,language:locale.code});
    await app.controller.showMessage('reply');
    const first=bodyGeometry(app),total=Number(first.footer.content.match(/^\d+\/(\d+)/)![1]);
    assert.equal(first.input.height,(long?2:1)*G2_LINE_HEIGHT,locale.code);
    assert.ok(total>=10,'exercise two-digit page counts');
    const read:string[]=[];
    for(let page=0;page<total;page++){
      const frame=bodyGeometry(app);read.push(frame.body.content);
      assert.match(frame.footer.content,new RegExp(`^${page+1}/${total}(?: |\\n)`),locale.code);
      assert.doesNotMatch(frame.body.content,/…$/,'body pagination must not summarize a page');
      if(page<total-1){app.emit({sysEvent:{}});await settle();}
    }
    assert.equal(read.join('\n'),wrapLines(`Muse: ${reply}`).join('\n'),locale.code);
  }
});

test('photo pages omit input and captions until the following chat or Space text page',async t=>{
  const original=Glasses.prototype.show,photos:Array<{body:string;footer:string;style:unknown}>=[];
  t.mock.method(Glasses.prototype,'show',async function(this:Glasses,...args:Parameters<Glasses['show']>){
    if(args[3]){photos.push({body:args[1],footer:args[2]||'',style:args[5]});return;}
    await original.apply(this,args);
  });
  const snapshot=fixture(),asset={mime:'image/png',name:'synthetic.png',data_base64:'c3ludGhldGlj'};
  snapshot.messages=[{id:'ask',from:'You',type:'text',text:'画像の質問',ts:1},
    {id:'reply',from:'Muse',type:'image',text:'画像の説明をここで読む',reply_to:'ask',ts:2}];
  const app=await appFixture(t,snapshot);
  app.controller.state.snapshot.messages.find(m=>m.id==='reply')!.image=asset;
  await app.controller.showMessage('reply');
  assert.equal(photos.length,1);assert.equal(photos[0]!.body,'');assert.equal(photos[0]!.style,undefined);
  assert.match(photos[0]!.footer,/^1\/2/);
  app.emit({sysEvent:{}});await settle();
  let frame=bodyGeometry(app);assert.match(frame.body.content,/画像の説明をここで読む/);assert.match(frame.input.content,/画像の質問/);
  app.controller.state.snapshot.spaces[0]!.items[0]!.image=asset;
  await app.controller.showSpace('test-space');
  assert.equal(photos.length,2);assert.equal(photos[1]!.body,'');assert.equal(photos[1]!.style,undefined);
  app.emit({sysEvent:{}});await settle();
  frame=bodyGeometry(app);assert.match(frame.body.content,/テストカードの本文/);assert.equal(frame.input,undefined);
});

test('space lists operate buttons, sliders and choices with explicit sends and local cancel',async t=>{
  const app=await appFixture(t,interactiveFixture());
  await app.controller.showSpace('test-space');assert.equal(app.items().length,5);
  app.emit({listEvent:{containerID:3}});await until(()=>app.text().includes('予定の本文'),'read a list item');
  app.emit({sysEvent:{eventType:3}});await until(()=>app.items().length===5,'back returns to items');
  app.emit({listEvent:{currentSelectItemIndex:2}});await until(()=>app.text().includes('25 分'),'slider editor');
  app.emit({textEvent:{eventType:1}});await until(()=>app.text().includes('30 分'),'swipe changes the draft');
  await app.controller.refresh();assert.match(app.text(),/30 分/,'polling must not reset an unsent edit');
  app.emit({sysEvent:{eventType:3}});await until(()=>app.items().length===5,'cancel returns to list');assert.equal(app.sent.length,0);
  app.emit({listEvent:{currentSelectItemIndex:2}});await until(()=>app.text().includes('25 分'),'cancel discarded the draft');
  app.emit({textEvent:{eventType:1}});await until(()=>app.text().includes('30 分'),'adjust again');
  app.emit({sysEvent:{}});await until(()=>app.controller.state.spaceAction?.status==='sent','send once');
  assert.deepEqual(app.sent[0]!.space_action,{item_id:'slider',type:'slider',value:30});assert.equal(app.sent[0]!.kind,'space');
  app.emit({sysEvent:{eventType:3}});await until(()=>app.items().length===5,'after sending return to list');
  app.emit({listEvent:{currentSelectItemIndex:3}});await until(()=>app.items().includes('詳しく'),'choice list');
  app.emit({listEvent:{currentSelectItemIndex:1}});await until(()=>app.sent.length===2&&!app.controller.state.busy,'choice sends');
  assert.deepEqual(app.sent[1]!.space_action,{item_id:'choice',type:'choice',value:'full'});
  app.emit({sysEvent:{eventType:3}});await until(()=>app.items().length===5,'list again');
  app.setSend(async()=>new Response('{}',{status:503}));
  app.emit({listEvent:{currentSelectItemIndex:1}});await until(()=>app.controller.state.spaceAction?.status==='error','visible action error');
  app.setSend(async()=>new Response('{}'));app.emit({sysEvent:{}});
  await until(()=>app.controller.state.spaceAction?.status==='sent','retry accepted');
  assert.equal(app.sent[2]!.id,app.sent[3]!.id,'ambiguous failure retries the same id');
});

test('slider track fills the display at a constant width and Space rows keep useful Latin descriptions',async t=>{
  const snapshot=interactiveFixture(),description='a b c d e f g h i j k l m n o p q r s t';
  snapshot.spaces[0]!.items[0]!.title='A';snapshot.spaces[0]!.items[0]!.text=description;
  snapshot.spaces[0]!.items[2]!.control={type:'slider',min:0,max:100,step:50,value:50};
  const app=await appFixture(t,snapshot);await app.controller.showSpace('test-space');
  assert.ok(app.items()[0]!.includes(description),'the controller does not cut the subtitle at 24 characters');
  await app.controller.activateSpaceItem('test-space','slider');
  const track=()=>bodyGeometry(app).body.content.match(/^\[-*O-*\]$/m)![0];
  const middle=track();app.emit({textEvent:{eventType:2}});await settle();const min=track();
  app.emit({textEvent:{eventType:1}});await settle();app.emit({textEvent:{eventType:1}});await settle();const max=track();
  const widths=[min,middle,max].map(value=>getTextWidth(value));
  assert.ok(widths[0]!>550&&widths[0]!<=576);assert.deepEqual(widths,[widths[0],widths[0],widths[0]]);
  assert.equal(min.indexOf('O'),1);assert.equal(max.indexOf('O'),max.length-2);
  assert.equal(middle.indexOf('O'),(middle.length-1)/2,'the middle value uses the middle cell');
  assert.equal(app.sent.length,0,'moving the thumb does not send');
});

test('phone slider keeps the relay receipt when the glasses reject the result display',async t=>{
  const app=await appFixture(t,interactiveFixture());
  const original=app.bridge.textContainerUpgrade;
  let resultDisplayFailed=false;
  t.mock.method(app.bridge,'textContainerUpgrade',async (value: Parameters<typeof original>[0])=>{
    if(value.content?.includes('中継が受け付けました')){resultDisplayFailed=true;return false;}
    return original(value);
  });
  let completeSend:(response: Response)=>void=()=>{};
  app.setSend(()=>new Promise(resolve=>{completeSend=resolve;}));
  const pending=app.controller.submitSpaceAction('test-space','slider',30);
  await until(()=>app.sent.length===1&&app.text().includes('操作を送信中'),'pending feedback on the glasses');
  completeSend(new Response('{}',{status:202}));
  await pending;
  await until(()=>resultDisplayFailed,'the actual receipt frame was rejected');
  assert.deepEqual(app.sent[0]!.space_action,{item_id:'slider',type:'slider',value:30});
  assert.equal(app.controller.state.spaceAction?.status,'sent');
  assert.equal(app.controller.state.error,'');
  assert.equal(app.sent.length,1);
});

test('space microphone keeps its target and cancellation never sends',async t=>{
  const app=await appFixture(t,interactiveFixture());
  await app.controller.showSpace('test-space');
  app.emit({listEvent:{currentSelectItemIndex:4}});
  await until(()=>app.controller.state.recording&&app.text().includes('メモ'),'the selected microphone opens and displays the Space item');
  assert.match(app.text(),/メモ/);
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000)}});
  app.emit({sysEvent:{eventType:3}});await until(()=>!app.controller.state.recording&&!app.controller.state.busy,'cancel capture');
  assert.equal(app.sent.length,0);
  app.emit({sysEvent:{}});await until(()=>app.items().length===5,'back after cancellation');
  app.emit({listEvent:{currentSelectItemIndex:4}});await until(()=>app.controller.state.recording,'record again');
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000)}});
  app.document.hidden=true;app.document.dispatchEvent(new Event('visibilitychange'));
  app.emit({sysEvent:{eventSource:2}});await until(()=>app.sent.length===1&&!app.controller.state.busy,'ring sends in background');
  assert.equal(app.sent[0]!.space_id,'test-space');assert.deepEqual(app.sent[0]!.space_action,{item_id:'mic',type:'microphone'});
  assert.equal(app.sent[0]!.audio?.mime,'audio/wav');
});

test('contextual list switching keeps the parent list and long confirmations require the final page',async t=>{
  const snapshot=interactiveFixture(),confirm=Array.from({length:10},(_,i)=>`確認 ${i+1}`).join('\n');
  snapshot.spaces[0]!.items[1]!.control={type:'button',confirm};
  const app=await appFixture(t,snapshot);await app.controller.showSpace('test-space');
  app.overlay(8);await until(()=>app.text().includes('予定の本文'),'contextual card view');
  app.overlay(9);await until(()=>app.items().length===5,'contextual items list');
  app.emit({listEvent:{}});await until(()=>app.text().includes('予定の本文'),'open text');
  app.emit({sysEvent:{eventType:3}});await until(()=>app.items().length===5,'return to the actual parent list');
  app.emit({listEvent:{currentSelectItemIndex:1}});await until(()=>app.text().includes('確認 1'),'show confirmation');
  const read=[bodyGeometry(app).body.content];
  while(!bodyGeometry(app).footer.content.includes('タップ: 実行')){
    assert.equal(app.sent.length,0);app.emit({sysEvent:{}});await settle();read.push(bodyGeometry(app).body.content);
  }
  assert.equal(read.join('\n'),wrapLines(`要約\n\n${confirm}`).join('\n'));
  assert.equal(app.sent.length,0);
  app.emit({sysEvent:{}});await until(()=>app.sent.length===1,'final tap runs the button');
});

test('long control cards and slider titles remain readable before a tap can send',async t=>{
  const snapshot=interactiveFixture(),card=Array.from({length:25},(_,i)=>`詳細 ${i+1}`).join('\n'),title=Array.from({length:12},(_,i)=>`Title${i+1}`).join('\n');
  snapshot.spaces[0]!.items[1]!.text=card;snapshot.spaces[0]!.items[2]!.title=title;
  const app=await appFixture(t,snapshot);await app.controller.showSpace('test-space','run');
  const read=[bodyGeometry(app).body.content];
  while(!bodyGeometry(app).footer.content.includes('タップ: 選択')){
    assert.equal(app.sent.length,0);app.emit({sysEvent:{}});await settle();read.push(bodyGeometry(app).body.content);
  }
  assert.equal(read.join('\n'),wrapLines(`要約\n${card}\n\n実行`).join('\n'));
  assert.equal(app.sent.length,0);app.emit({sysEvent:{}});await until(()=>app.sent.length===1&&!app.controller.state.busy,'card sends after its last page');
  await app.controller.activateSpaceItem('test-space','slider');
  const sliderRead=[bodyGeometry(app).body.content];
  assert.ok(!bodyGeometry(app).footer.content.includes('タップ: 送信'),'a long title requires more than one page');
  while(!bodyGeometry(app).footer.content.includes('タップ: 送信')){
    assert.equal(app.sent.length,1);app.emit({sysEvent:{}});await settle();sliderRead.push(bodyGeometry(app).body.content);
  }
  const track=sliderRead.join('\n').match(/^\[-*O-*\]$/m)![0];
  assert.equal(sliderRead.join('\n'),wrapLines(`${title}\n\n25 分\n${track}\n5 — 60\nスワイプ: 値を調整`).join('\n'));
  assert.equal(app.sent.length,1);app.emit({sysEvent:{}});await until(()=>app.sent.length===2,'slider sends after its last page');
  assert.deepEqual(app.sent[1]!.space_action,{item_id:'slider',type:'slider',value:25});
});

test('long space lists expose every item and reject a changed control before sending',async t=>{
  const snapshot=interactiveFixture();
  for(let n=5;n<50;n++)snapshot.spaces[0]!.items.push({id:`item-${n}`,title:`項目 ${n}`,text:`本文 ${n}`});
  const app=await appFixture(t,snapshot);await app.controller.showSpace('test-space');
  assert.equal(app.items().length,19);app.emit({listEvent:{currentSelectItemIndex:18}});
  await until(()=>app.items()[0]?.startsWith('項目 18'),'second list page');assert.equal(app.items().length,20);
  app.emit({listEvent:{currentSelectItemIndex:19}});await until(()=>app.items()[0]?.startsWith('項目 36'),'third list page');
  assert.ok(app.items().some((label:string)=>label.startsWith('項目 49')));
  await app.controller.activateSpaceItem('test-space','slider');
  snapshot.spaces[0]!.items[2]!.control={type:'slider',min:40,max:60,step:5,value:40};
  await app.controller.refresh();app.emit({sysEvent:{}});
  await until(()=>app.text().includes('更新されています'),'stale edit is visible');assert.equal(app.sent.length,0);
});

test('speaker selection filters Muse recordings without changing timing, defaults or phone audio',async t=>{
  const app=await appFixture(t);
  const parts=['self','other','unknown',undefined].map((speakerRole,index)=>({speakerRole,audioPcm:new Uint8Array(24000).fill(index+1)}));
  const choices=[{speakerFilter:'all',mic:'glasses'},{speakerFilter:'self',mic:'glasses'},
    {speakerFilter:'other',mic:'glasses'},{speakerFilter:'self',mic:'phone'}] as const;
  assert.equal(app.controller.state.settings.speakerFilter,'all');
  for(const choice of choices){
    await app.controller.saveSettings({...app.controller.state.settings,...choice});
    await app.controller.toggleRecording();
    for(const audio of parts)app.emit({audioEvent:{...audio,source:choice.mic}});
    await app.controller.toggleRecording();
    const sent=app.sent.at(-1)!;
    const actual=Buffer.from(sent.audio!.data_base64,'base64');
    const expected=Buffer.concat(parts.map(audio=>Buffer.from(choice.mic==='phone'||choice.speakerFilter==='all'||choice.speakerFilter===audio.speakerRole
      ?audio.audioPcm:new Uint8Array(audio.audioPcm.length))));
    assert.equal(actual.readUInt32LE(40),expected.length,'WAV duration includes muted frames');
    assert.deepEqual(actual.subarray(44),expected,`${choice.mic} / ${choice.speakerFilter}`);
  }
  assert.ok(parts.every((audio,index)=>audio.audioPcm.every(byte=>byte===index+1)),'SDK buffers are never changed');
  await app.controller.saveSettings({...app.controller.state.settings,mic:'glasses',speakerFilter:'self'});
  await app.controller.toggleRecording();
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000).fill(9)}});
  await app.controller.toggleRecording();
  assert.equal(app.sent.length,choices.length,'unclassified audio cannot become a selected-speaker request');
  assert.match(app.controller.state.notice,/話者を判定できません/);
});

test('space microphone filters audio before Soniox and keeps the selected item',async t=>{
  const original=globalThis.WebSocket;
  const audioFrames:Uint8Array[]=[];
  class Socket{
    static OPEN=1;readyState=1;bufferedAmount=0;
    onopen?:()=>void;onmessage?:(event:{data:string})=>void;onclose?:()=>void;
    constructor(){queueMicrotask(()=>this.onopen?.());}
    send(value:unknown){
      if(value instanceof ArrayBuffer){
        const pcm=new Uint8Array(value);audioFrames.push(pcm);
        if(pcm.some(byte=>byte!==0))this.onmessage?.({data:JSON.stringify({tokens:[{text:'買い物',is_final:false}]})});
      }
      if(value==='')this.onmessage?.({data:JSON.stringify({tokens:[{text:'買い物メモ',is_final:true}],finished:true})});
    }
    close(){this.readyState=3;this.onclose?.();}
  }
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;t.after(()=>{globalThis.WebSocket=original;});
  const app=await appFixture(t,interactiveFixture());
  await app.controller.saveSettings({...app.controller.state.settings,voice:'soniox',speakerFilter:'self'});
  await app.controller.activateSpaceItem('test-space','mic');
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000).fill(2),speakerRole:'other'}});
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000).fill(3),speakerRole:'unknown'}});
  assert.equal(app.controller.state.transcript,'');
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000).fill(1),speakerRole:'self'}});assert.equal(app.controller.state.transcript,'買い物');
  assert.deepEqual(audioFrames,[new Uint8Array(24000),new Uint8Array(24000),new Uint8Array(24000).fill(1)]);
  await app.controller.toggleRecording();
  assert.equal(app.sent[0]!.text,'買い物メモ');assert.equal(app.sent[0]!.audio,undefined);
  assert.deepEqual(app.sent[0]!.space_action,{item_id:'mic',type:'microphone'});
});

test('live recording shows the latest recognized lines without rebuilding its layout',async t=>{
  const original=globalThis.WebSocket;
  let socket:Socket|undefined;
  class Socket{
    static OPEN=1;readyState=1;bufferedAmount=0;
    onopen?:()=>void;onmessage?:(event:{data:string})=>void;onclose?:()=>void;
    constructor(){socket=this;queueMicrotask(()=>this.onopen?.());}
    send(){}
    close(){this.readyState=3;this.onclose?.();}
  }
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;t.after(()=>{globalThis.WebSocket=original;});
  const app=await appFixture(t,fixture(),true),microphone:boolean[]=[];
  app.bridge.audioControl=async(open=false)=>{microphone.push(open);return true;};
  await app.controller.saveSettings({...app.controller.state.settings,voice:'soniox'});
  await app.controller.toggleRecording();
  const geometry=()=>app.containers().map((c:any)=>[c.containerName,c.xPosition,c.yPosition,c.width,c.height]);
  const initial=geometry(),rebuilds=app.operations.filter(op=>op==='rebuild:text').length;
  for(const length of [1,32,40]){
    const transcript=Array.from({length},(_,i)=>`発話 ${i+1}`).join('\n');
    socket!.onmessage?.({data:JSON.stringify({tokens:[{text:transcript,is_final:false}]})});
    t.mock.timers.tick(400);await settle();
    const frame=bodyGeometry(app);
    assert.equal(frame.input,undefined);assert.match(frame.body.content,new RegExp(`発話 ${length}$`));
    if(length>frame.rows)assert.doesNotMatch(frame.body.content,/(?:^|\n)発話 1(?:\n|$)/,'old lines scroll out rather than hiding new words');
    assert.deepEqual(geometry(),initial);assert.equal(app.operations.filter(op=>op==='rebuild:text').length,rebuilds);
    assert.deepEqual(microphone,[true],'transcript updates do not restart the microphone');
  }
  app.emit({sysEvent:{eventType:3}});await settle();
  assert.equal(app.controller.state.recording,false);assert.deepEqual(microphone,[true,false]);assert.equal(app.sent.length,0);
});

for (const auth of ['api-key','token-server'] as const) {
  test(`Soniox ${auth} records before connecting and finalizes a release before the socket opens`,{timeout:4000},async t=>{
    const original=globalThis.WebSocket, sockets:Socket[]=[];
    const frames:Buffer[]=[];
    let endSent=false;
    class Socket {
      static OPEN=1;
      readyState=0;
      bufferedAmount=0;
      onopen?:()=>void;
      onmessage?:(event:{data:string})=>void;
      onclose?:()=>void;
      constructor(readonly url:string,readonly protocols:string[]){sockets.push(this);}
      open(){this.readyState=1;this.onopen?.();}
      send(value:string|ArrayBuffer){
        if(value instanceof ArrayBuffer){
          assert.equal(endSent,false,'audio must precede the end frame');
          assert.ok(value.byteLength<=3200,'buffered audio is sent in small chunks');
          frames.push(Buffer.from(value));
        }else if(value===''){
          endSent=true;
          this.onmessage?.({data:JSON.stringify({tokens:[{text:'予約の確認',is_final:true}],finished:true})});
        }else assert.equal(JSON.parse(value).sample_rate,16000);
      }
      close(){this.readyState=3;this.onclose?.();}
    }
    globalThis.WebSocket=Socket as unknown as typeof WebSocket;
    t.after(()=>{globalThis.WebSocket=original;});
    const app=await appFixture(t,fixture(),false,{voice:'soniox',sonioxAuth:auth,sonioxApiKey:'synthetic-direct',speakerFilter:'self'});
    const key=deferred<Response>(),posted=deferred<void>();
    let requestedKeys=0;
    app.setSonioxKey(()=>{requestedKeys++;return key.promise;});
    app.setSend(async()=>{posted.resolve();return Response.json({});});
    const microphone:boolean[]=[];
    app.bridge.audioControl=async(open=false)=>{microphone.push(open);return true;};
    app.emit({sysEvent:{eventType:9}});
    await until(()=>microphone.length===1,'audio starts while authentication or WebSocket setup is pending');
    assert.equal(app.controller.state.recording,true);
    assert.equal(requestedKeys,auth==='token-server'?1:0);
    assert.ok(sockets.every(socket=>socket.readyState===0));
    app.emit({audioEvent:{audioPcm:new Uint8Array(9600).fill(11),speakerRole:'self'}});
    app.emit({audioEvent:{audioPcm:new Uint8Array(3200).fill(99),speakerRole:'other'}});
    app.emit({audioEvent:{audioPcm:new Uint8Array(9600).fill(22),speakerRole:'self'}});
    app.emit({sysEvent:{eventType:10}});
    await until(()=>microphone.length===2,'release closes the microphone while still offline');
    assert.deepEqual(microphone,[true,false]);
    assert.equal(app.controller.state.recording,false);
    assert.deepEqual(frames,[]);
    assert.equal(app.sent.length,0);
    app.emit({audioEvent:{audioPcm:new Uint8Array(3200).fill(88),speakerRole:'self'}});
    if(auth==='token-server')key.resolve(Response.json({api_key:'snx_temp_synthetic'}));
    await until(()=>sockets.length===1,'the delayed Soniox socket is created');
    assert.equal(sockets[0]!.url,'wss://stt-rt.soniox.com/transcribe-websocket');
    assert.deepEqual(sockets[0]!.protocols,['soniox-api-key',auth==='api-key'?'synthetic-direct':'snx_temp_synthetic']);
    sockets[0]!.open();
    assert.equal(endSent,false,'the socket is not finalized while audio is still queued');
    await posted.promise;
    await until(()=>!app.controller.state.busy,'the final text submission completes');
    assert.equal(endSent,true);
    assert.deepEqual(Buffer.concat(frames),Buffer.concat([Buffer.alloc(9600,11),Buffer.alloc(3200),Buffer.alloc(9600,22)]));
    assert.equal(app.sent[0]!.text,'予約の確認');
    assert.equal(app.sent[0]!.audio,undefined);
    assert.doesNotMatch(JSON.stringify(app.sent),/synthetic-direct|snx_temp/);
  });
}

test('cancelling a released recording aborts the pending Soniox key and clears its audio',async t=>{
  const app=await appFixture(t,fixture(),false,{voice:'soniox',sonioxAuth:'token-server'});
  let tokenSignal:AbortSignal|undefined;
  app.setSonioxKey(({signal})=>{
    tokenSignal=signal!;
    return new Promise((_resolve,reject)=>tokenSignal!.addEventListener('abort',()=>reject(tokenSignal!.reason),{once:true}));
  });
  const microphone:boolean[]=[];
  app.bridge.audioControl=async(open=false)=>{microphone.push(open);return true;};
  app.emit({sysEvent:{eventType:9}});
  await until(()=>microphone.length===1&&!!tokenSignal,'the mic is open while a key is pending');
  app.emit({audioEvent:{audioPcm:new Uint8Array(19200).fill(1),speakerRole:'self'}});
  app.emit({sysEvent:{eventType:10}});
  await until(()=>microphone.length===2&&!app.controller.state.recording,'release stops capture');
  assert.equal(app.controller.state.busy,true,'the end of recording is still waiting for authentication');
  app.emit({sysEvent:{eventType:3}});
  await until(()=>!app.controller.state.busy,'cancel exits the pending transcription');
  assert.equal(tokenSignal!.aborted,true);
  assert.deepEqual(microphone,[true,false]);
  assert.equal(app.sent.length,0);
  assert.match(app.controller.state.notice,/中止/);
});

test('a Soniox connection failure closes the active microphone without sending audio or text',async t=>{
  const app=await appFixture(t,fixture(),false,{voice:'soniox',sonioxAuth:'token-server'});
  const key=deferred<Response>();
  app.setSonioxKey(()=>key.promise);
  const microphone:boolean[]=[];
  app.bridge.audioControl=async(open=false)=>{microphone.push(open);return true;};
  app.emit({sysEvent:{eventType:9}});
  await until(()=>microphone.length===1&&app.controller.state.recording,'the recorder does not wait for the key');
  app.emit({audioEvent:{audioPcm:new Uint8Array(19200).fill(1),speakerRole:'self'}});
  key.resolve(new Response('{}',{status:503}));
  await until(()=>microphone.length===2&&!app.controller.state.busy&&Boolean(app.controller.state.error),'the connection failure is reported after closing the microphone');
  assert.equal(app.controller.state.recording,false);
  assert.deepEqual(microphone,[true,false]);
  assert.equal(app.sent.length,0);
});

test('display timeout keeps receiving in background and the first gesture only restores the prior screen',async t=>{
  const snapshot=fixture();
  snapshot.spaces[0]!.items[0]!.text=Array.from({length:14},(_,i)=>`本文 ${i+1}`).join('\n');
  const app=await appFixture(t,snapshot,true);
  t.mock.timers.tick(30000);await settle();assert.equal(app.controller.state.displaySleeping,false,'auto-hide is off by default');
  await app.controller.saveSettings({...app.controller.state.settings,autoHideSeconds:5});
  await app.controller.showSpace('test-space');const prior=app.text();
  app.document.hidden=true;app.document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(4000);await settle();await app.controller.refresh();
  t.mock.timers.tick(1000);await settle();
  assert.equal(app.controller.state.displaySleeping,true,'polling must not postpone hiding');
  assert.equal(app.text().trim(),'');assert.deepEqual(app.items(),[],'no native list border may remain');
  snapshot.messages.push({id:'hidden-reply',from:'Muse',type:'text',text:'非表示中の受信',ts:50});
  await app.controller.refresh();
  assert.ok(app.controller.state.snapshot.messages.some(m=>m.id==='hidden-reply'));
  assert.equal(app.text().trim(),'');assert.ok(!app.controller.state.readIds.includes('hidden-reply'));
  app.document.hidden=false;app.document.dispatchEvent(new Event('visibilitychange'));await settle();
  assert.equal(app.text().trim(),'','phone foreground must not wake the glasses');
  app.emit({sysEvent:{eventSource:2}});await settle();assert.equal(app.text(),prior,'Ring tap restores without advancing');
  app.emit({sysEvent:{eventSource:2}});await settle();assert.notEqual(app.text(),prior,'a second tap advances normally');
  const secondPage=app.text();t.mock.timers.tick(5000);await settle();
  app.emit({textEvent:{eventType:2,containerID:1}});await settle();assert.equal(app.text(),secondPage,'wake swipe does not change the item/page');
  app.emit({sysEvent:{eventType:4}});t.mock.timers.tick(30000);await settle();
  assert.equal(app.controller.state.displaySleeping,false,'system menu pauses the timeout');
  app.emit({sysEvent:{eventType:5}});await settle();t.mock.timers.tick(5000);await settle();
  assert.equal(app.text().trim(),'');
  await app.controller.saveSettings({...app.controller.state.settings,autoHideSeconds:0});await settle();
  assert.equal(app.text(),secondPage,'turning the setting off restores the current screen');
  t.mock.timers.tick(30000);await settle();assert.equal(app.text(),secondPage);
});

test('holding while hidden records chat and its reply wakes the timed-out display once',async t=>{
  const snapshot=interactiveFixture(),app=await appFixture(t,snapshot,true),mic:boolean[]=[];
  app.bridge.audioControl=async(open=false)=>{mic.push(open);return true;};
  await app.controller.saveSettings({...app.controller.state.settings,autoHideSeconds:5});
  await app.controller.showSpace('test-space');
  t.mock.timers.tick(5000);await settle();assert.equal(app.text().trim(),'');
  app.emit({sysEvent:{eventType:9,eventSource:3}});await settle();
  assert.equal(app.controller.state.recording,true);assert.match(app.text(),/録音中/);
  t.mock.timers.tick(6000);await settle();assert.equal(app.controller.state.displaySleeping,false,'recording is never auto-hidden');
  app.emit({audioEvent:{audioPcm:new Uint8Array(24000)}});
  app.emit({sysEvent:{eventType:10,eventSource:3}});await settle();
  assert.deepEqual(mic,[true,false]);assert.equal(app.sent.length,1);assert.equal(app.sent[0]!.kind,'chat');
  assert.equal(app.controller.state.selectedMessageId,app.sent[0]!.id);assert.match(app.text(),/音声メッセージ/);
  // Fast receives do not continually restart the display deadline.
  for(let second=0;second<5;second++){t.mock.timers.tick(1000);await settle();}
  assert.equal(app.text().trim(),'');
  snapshot.messages.push({id:'voice-reply',reply_to:app.sent[0]!.id,from:'Muse',type:'text',text:'音声への返信',ts:30});
  t.mock.timers.tick(1000);await settle();
  assert.equal(app.controller.state.selectedMessageId,'voice-reply');assert.equal(app.controller.state.displaySleeping,false);
  assert.match(app.text(),/音声への返信/,'the explicitly linked Muse answer restores the waiting chat');
  assert.ok(app.controller.state.readIds.includes('voice-reply'));
  t.mock.timers.tick(5000);await settle();assert.equal(app.text().trim(),'');
  snapshot.messages[0]!.text+=' 追加';await app.controller.refresh();assert.equal(app.text().trim(),'','streaming the same answer cannot wake twice');
  await app.controller.restoreDisplay();assert.match(app.text(),/音声への返信/);
  app.emit({sysEvent:{eventType:7}});const frames=app.frames.length;t.mock.timers.tick(30000);await settle();
  assert.equal(app.frames.length,frames,'system exit clears the display timeout');
});

test('Gist replies wake each outstanding chat once and ignore history, status, echoes and empty updates',async t=>{
  const snapshot=fixture(),app=await appFixture(t,snapshot,true,{relay:'gist',
    gistId:'0123456789abcdef0123456789abcdef',githubToken:'synthetic-navigation-test',autoHideSeconds:5});
  await app.controller.sendText('最初の依頼');await app.controller.sendText('次の依頼');
  const [first,second]=app.sent;
  t.mock.timers.tick(5000);await settle();assert.equal(app.text().trim(),'');
  snapshot.messages[0]!.reply_to=first!.id;snapshot.messages[0]!.text='前からある履歴の更新';
  snapshot.messages.push(
    {id:'accepted',reply_to:first!.id,from:'Relay',type:'text',text:'Accepted by relay',ts:20},
    {id:'status_processing',reply_to:second!.id,from:'Muse',type:'text',text:'Processing',ts:21},
    {id:'echo',reply_to:second!.id,from:'You',type:'text',text:'文字起こし',ts:22},
    {id:'unrelated',reply_to:'different-request',from:'Muse',type:'text',text:'別の会話',ts:23},
    {id:'legacy',from:'Muse',type:'text',text:'返信先のない投稿',ts:24},
    {id:'first-answer',reply_to:first!.id,from:'Muse',type:'text',text:' ',ts:25});
  await app.controller.refresh();assert.equal(app.text().trim(),'');
  snapshot.messages.at(-1)!.text='最初の回答';await app.controller.refresh();
  assert.match(app.text(),/最初の回答/,'an existing empty stream row becoming readable is a new answer');
  assert.equal(app.controller.state.selectedMessageId,'first-answer','an older outstanding send is still correlated');
  t.mock.timers.tick(5000);await settle();assert.equal(app.text().trim(),'');
  snapshot.messages.at(-1)!.text+=' 追記';await app.controller.refresh();assert.equal(app.text().trim(),'');
  snapshot.messages.push({id:'second-answer',reply_to:second!.id,from:'Muse',type:'text',text:'次の回答',ts:26});
  await app.controller.refresh();assert.match(app.text(),/次の回答/);
  t.mock.timers.tick(5000);await settle();await app.controller.refresh();assert.equal(app.text().trim(),'');
  await app.controller.saveSettings({...app.controller.state.settings,images:false});
  await app.controller.sendText('画像の回答');t.mock.timers.tick(5000);await settle();
  snapshot.messages.push({id:'image-answer',reply_to:app.sent.at(-1)!.id,from:'Muse',type:'image',text:'',image_file:'synthetic.png',ts:27});
  await app.controller.refresh();assert.equal(app.text().trim(),'','disabled images are not a displayable answer');
  await app.controller.saveSettings({...app.controller.state.settings,images:true});
  await app.controller.refresh();assert.equal(app.text().trim(),'','enabling images is not a newly received answer');
  await app.controller.saveSettings({...app.controller.state.settings,images:false});
  snapshot.messages.at(-1)!.text='画像の説明';await app.controller.refresh();assert.match(app.text(),/画像の説明/);
});

test('read or hidden answers, recording, failed sends and exit cannot trigger a delayed reply wake',async t=>{
  const snapshot=fixture(),app=await appFixture(t,snapshot,true,{autoHideSeconds:5});
  const sendAndHide=async(text:string)=>{
    await app.controller.sendText(text);t.mock.timers.tick(5000);await settle();
    assert.equal(app.text().trim(),'');return app.sent.at(-1)!.id;
  };
  const readId=await sendAndHide('端末で既読にする');
  snapshot.messages.push({id:'read-answer',reply_to:readId,from:'Muse',type:'text',text:'',ts:20});
  await app.controller.refresh();await app.controller.markRead(['read-answer']);
  snapshot.messages.at(-1)!.text='既読の回答';await app.controller.refresh();assert.equal(app.text().trim(),'');
  const hiddenId=await sendAndHide('手動で隠す');await app.controller.hideMessage(hiddenId);
  snapshot.messages.push({id:'hidden-answer',reply_to:hiddenId,from:'Muse',type:'text',text:'隠した依頼への回答',ts:30});
  await app.controller.refresh();assert.equal(app.text().trim(),'');
  const recordingId=await sendAndHide('録音中に受信');await app.controller.toggleRecording();
  snapshot.messages.push({id:'recording-answer',reply_to:recordingId,from:'Muse',type:'text',text:'録音中の回答',ts:40});
  await app.controller.refresh();assert.equal(app.controller.state.recording,true);assert.match(app.text(),/録音中/);
  assert.ok(!app.controller.state.readIds.includes('recording-answer'));
  await app.controller.cancelRecording();t.mock.timers.tick(5000);await settle();
  snapshot.messages.at(-1)!.text+=' 追記';await app.controller.refresh();assert.equal(app.text().trim(),'');
  app.setSend(async()=>new Response('{}',{status:503}));
  await assert.rejects(app.controller.sendText('失敗した依頼'),/HTTP 503/);
  snapshot.messages.push({id:'failed-answer',reply_to:app.sent.at(-1)!.id,from:'Muse',type:'text',text:'未受理の依頼への行',ts:50});
  await app.controller.refresh();assert.equal(app.text().trim(),'');
  app.setSend(async()=>new Response('{}'));const exitingId=await sendAndHide('終了後に受信');
  const pending=deferred<Response>();app.setRead(()=>pending.promise);const reading=app.controller.refresh();
  app.emit({sysEvent:{eventType:7}});const frames=app.frames.length;
  snapshot.messages.push({id:'exit-answer',reply_to:exitingId,from:'Muse',type:'text',text:'終了後の回答',ts:60});
  pending.resolve(response(snapshot));await reading;assert.equal(app.frames.length,frames);
});

test('reply wake supersedes a queued blank frame and starts its timeout after the answer render',async t=>{
  const snapshot=fixture(),app=await appFixture(t,snapshot,true,{autoHideSeconds:5});
  await app.controller.sendText('表示待ちの依頼');
  const blank=deferred<void>(),rebuild=app.bridge.rebuildPageContainer;let delayed=false;
  app.bridge.rebuildPageContainer=async value=>{
    if(!delayed&&value.textObject?.every((item:any)=>!item.content?.trim())){delayed=true;await blank.promise;}
    return rebuild(value);
  };
  t.mock.timers.tick(5000);await settle();assert.equal(delayed,true);
  snapshot.messages.push({id:'queued-answer',reply_to:app.sent[0]!.id,from:'Muse',type:'text',text:'描画後にタイマー開始',ts:30});
  const reading=app.controller.refresh();await settle();
  t.mock.timers.tick(6000);await settle();assert.equal(app.controller.state.displaySleeping,false);
  blank.resolve();await reading;assert.match(app.text(),/描画後にタイマー開始/);
  assert.ok(!app.operations.includes('upgrade:missing'));
  t.mock.timers.tick(4999);await settle();assert.equal(app.controller.state.displaySleeping,false);
  t.mock.timers.tick(1);await settle();assert.equal(app.text().trim(),'');
});

test('successful chat sends return to chat with an opt-out and failed sends never navigate or invite a duplicate retry',async t=>{
  const snapshot=fixture();snapshot.capabilities={audio:true,images:true,spaces:true};
  const app=await appFixture(t,snapshot,true,{autoHideSeconds:5});
  await app.controller.showSpace('test-space');
  await app.controller.sendText('送った本文');assert.match(app.text(),/送った本文/);
  snapshot.messages.push({id:'text-reply',reply_to:app.sent[0]!.id,from:'Muse',type:'text',text:'テキストへの返信',ts:11});
  t.mock.timers.tick(1000);await settle();assert.match(app.text(),/テキストへの返信/);
  const pendingSend=deferred<Response>();app.setSend(()=>pendingSend.promise);
  const sending=app.controller.sendText('応答が先に届く',{mime:'image/png',name:'sample.png',data_base64:'c3ludGhldGlj'});
  await settle();t.mock.timers.tick(6000);await settle();
  assert.equal(app.controller.state.displaySleeping,false,'the relay is still accepting the outgoing photo');
  snapshot.messages.push({id:'early-reply',reply_to:app.sent[1]!.id,from:'Muse',type:'text',text:'先に受信した返信',ts:12});
  await app.controller.refresh();pendingSend.resolve(new Response('{}'));await sending;
  assert.match(app.text(),/先に受信した返信/,'a reply received before POST completion must not be lost');
  app.setSend(async()=>new Response('{}'));
  await app.controller.saveSettings({...app.controller.state.settings,returnToChatAfterSend:false});
  await app.controller.showSpace('test-space');const prior=app.text();
  await app.controller.sendText('復帰しない送信');assert.equal(app.text(),prior);
  await app.controller.saveSettings({...app.controller.state.settings,returnToChatAfterSend:true});
  app.setSend(async()=>new Response('{}',{status:503}));
  await assert.rejects(app.controller.sendText('送信失敗'),/HTTP 503/);assert.equal(app.text(),prior);
  app.setSend(async()=>new Response('{}'));
  app.bridge.rebuildPageContainer=async()=>false;
  await assert.doesNotReject(app.controller.sendText('中継では送信成功'));
  assert.match(app.controller.state.error,/接続|G2/,'display errors remain visible without rejecting the accepted send');
});

test('auto-hide waits for image retrieval and the final native image acknowledgement without extending for unchanged polls',async t=>{
  const snapshot=fixture();snapshot.messages[0]!.type='image';snapshot.messages[0]!.image_file='pending.png';
  const app=await appFixture(t,snapshot,true,{autoHideSeconds:5,returnToChatAfterSend:false}),image=deferred<Response>(),lastAck=deferred<void>();
  // Exercise the production transfer queue through the fake SDK bridge using synthetic tile bytes.
  const tiles=Array.from({length:4},(_,i)=>({x:i%2*288,y:Math.floor(i/2)*117,width:288,height:117,bytes:Uint8Array.of(i+1)}));
  t.mock.method(Glasses.prototype as unknown as {photoTiles:()=>Promise<typeof tiles>},'photoTiles',async()=>tiles);
  let transfers=0;
  app.bridge.updateImageRawData=async()=>{if(++transfers===4)await lastAck.promise;return ImageRawDataUpdateResult.success;};
  const attachment=()=>Response.json({mime:'image/png',name:'pending.png',data_base64:'c3ludGhldGlj'});
  app.onCleanup(()=>{image.resolve(attachment());lastAck.resolve();});
  app.setAttachment(()=>image.promise);
  const opening=app.controller.showMessage('test-message');await settle();assert.match(app.text(),/読み込み中/);
  t.mock.timers.tick(6000);await settle();
  assert.equal(app.controller.state.displaySleeping,false,'image retrieval must not consume the five visible seconds');
  assert.match(app.text(),/読み込み中/);assert.equal(transfers,0);
  image.resolve(attachment());await settle();
  t.mock.timers.tick(500);await settle();assert.equal(transfers,4,'the final image tile is awaiting its native ACK');
  t.mock.timers.tick(6000);await settle();
  assert.equal(app.controller.state.displaySleeping,false,'earlier tile ACKs must not start the display deadline');
  lastAck.resolve();await opening;await settle();
  assert.ok(app.controller.state.readIds.includes('test-message'));
  // Start the real one-second reply polling loop without changing the displayed image.
  const reads=app.requests.length;await app.controller.sendText('synthetic polling trigger');
  for(let second=0;second<4;second++){
    t.mock.timers.tick(1000);await settle();
    assert.equal(app.controller.state.displaySleeping,false);
  }
  assert.equal(app.requests.length,reads+4,'the unchanged image was polled every second');
  assert.equal(transfers,4,'unchanged snapshots retain the acknowledged image');
  t.mock.timers.tick(999);await settle();assert.equal(app.controller.state.displaySleeping,false,'4999 ms after the final ACK is still visible');
  t.mock.timers.tick(1);await settle();assert.equal(app.controller.state.displaySleeping,true);assert.equal(app.text().trim(),'');
});

test('auto-hide waits for the newest text page ACK when an earlier native frame completes during navigation',async t=>{
  const snapshot=fixture();snapshot.messages[0]!.text=Array.from({length:14},(_,i)=>`本文 ${String(i+1).padStart(2,'0')}`).join('\n');
  const app=await appFixture(t,snapshot,true,{autoHideSeconds:5}),firstAck=deferred<void>(),secondAck=deferred<void>();
  const rebuild=app.bridge.rebuildPageContainer,upgrade=app.bridge.textContainerUpgrade;
  let acknowledgements=0;
  const acknowledge=async()=>{
    if(acknowledgements===0&&app.text().includes('本文 01')){acknowledgements++;await firstAck.promise;}
    else if(acknowledgements===1&&app.text().includes('本文 14')){acknowledgements++;await secondAck.promise;}
  };
  app.bridge.rebuildPageContainer=async value=>{const result=await rebuild(value);await acknowledge();return result;};
  app.bridge.textContainerUpgrade=async value=>{const result=await upgrade(value);if(value.containerName==='footer')await acknowledge();return result;};
  app.onCleanup(()=>{firstAck.resolve();secondAck.resolve();});
  const opening=app.controller.showMessage('test-message');await settle();assert.equal(acknowledgements,1);
  t.mock.timers.tick(2000);app.emit({textEvent:{eventType:0,containerID:1}});await settle();
  t.mock.timers.tick(2000);firstAck.resolve();await opening;await settle();
  assert.equal(acknowledgements,2);assert.match(app.text(),/本文 14/);
  t.mock.timers.tick(6000);await settle();
  assert.equal(app.controller.state.displaySleeping,false,'a superseded frame ACK cannot start the pending page deadline');
  secondAck.resolve();await settle();const pageTwo=app.text();
  t.mock.timers.tick(4999);await settle();assert.equal(app.controller.state.displaySleeping,false);assert.equal(app.text(),pageTwo);
  t.mock.timers.tick(1);await settle();assert.equal(app.controller.state.displaySleeping,true);assert.equal(app.text().trim(),'');
});

test('auto-hide keeps the replacement answer deadline when an obsolete image fetch finishes later',async t=>{
  const snapshot=fixture();snapshot.messages[0]!.type='image';snapshot.messages[0]!.image_file='obsolete.png';
  const app=await appFixture(t,snapshot,true,{autoHideSeconds:5}),image=deferred<Response>();
  const attachment=()=>Response.json({mime:'image/png',name:'obsolete.png',data_base64:'c3ludGhldGlj'});
  app.onCleanup(()=>image.resolve(attachment()));app.setAttachment(()=>image.promise);
  const opening=app.controller.showMessage('test-message');await settle();assert.match(app.text(),/読み込み中/);
  t.mock.timers.tick(2000);
  snapshot.messages[0]={id:'test-message',from:'Muse',type:'text',text:'差し替わった回答',ts:2};
  await app.controller.refresh();assert.match(app.text(),/差し替わった回答/);
  const replacement=app.text();
  t.mock.timers.tick(1000);image.resolve(attachment());await opening;await settle();
  assert.equal(app.text(),replacement,'the obsolete image cannot repaint the replacement answer');
  t.mock.timers.tick(3999);await settle();assert.equal(app.controller.state.displaySleeping,false);assert.equal(app.text(),replacement);
  t.mock.timers.tick(1);await settle();assert.equal(app.controller.state.displaySleeping,true);assert.equal(app.text().trim(),'');
});

test('successful Gadget sends poll quickly in native background and system exit stops receives', async t => {
  const snapshot=fixture(),app=await appFixture(t,snapshot,true);
  await app.controller.saveSettings({...app.controller.state.settings,pollSeconds:15});
  const baseline=app.requests.length;
  await app.controller.sendText('synthetic reply polling');
  t.mock.timers.tick(999);await settle();assert.equal(app.requests.length,baseline);
  t.mock.timers.tick(1);await settle();assert.equal(app.requests.length,baseline+1);
  t.mock.timers.tick(1000);await settle();assert.equal(app.requests.length,baseline+2,'fast reads continue after the initial check');
  snapshot.messages.push({id:'reply',reply_to:app.sent[0]!.id,from:'Muse',type:'text',text:'受信済み',ts:10});
  t.mock.timers.tick(1000);await settle();
  for(let second=0;second<5;second++){t.mock.timers.tick(1000);await settle();}
  const afterReply=app.requests.length;
  t.mock.timers.tick(14999);await settle();assert.equal(app.requests.length,afterReply,'quiet replies return to the saved 15-second interval');
  t.mock.timers.tick(1);await settle();assert.equal(app.requests.length,afterReply+1);
  await app.controller.sendText('another synthetic request');
  app.document.hidden=true;app.document.dispatchEvent(new Event('visibilitychange'));
  const beforeBackground=app.requests.length;
  t.mock.timers.tick(1000);await settle();assert.equal(app.requests.length,beforeBackground+1,'native background keeps receiving the reply');
  app.emit({sysEvent:{eventType:7}});
  t.mock.timers.tick(130000);await settle();assert.equal(app.requests.length,beforeBackground+1,'system exit stops receives');
});

test('failed sends and failed receives do not leave rapid polling active', async t => {
  const app=await appFixture(t,fixture(),true);
  await app.controller.saveSettings({...app.controller.state.settings,pollSeconds:15});
  app.setSend(async()=>new Response('{}',{status:503}));
  await assert.rejects(app.controller.sendText('failed synthetic send'),/HTTP 503/);
  const baseline=app.requests.length;
  t.mock.timers.tick(1000);await settle();assert.equal(app.requests.length,baseline);
  app.setSend(async()=>new Response('{}'));
  await app.controller.sendText('successful synthetic send');
  app.setRead(async()=>new Response('{}',{status:503}));
  t.mock.timers.tick(1000);await settle();assert.equal(app.requests.length,baseline+1);
  t.mock.timers.tick(29999);await settle();assert.equal(app.requests.length,baseline+1,'receive failures use the existing backoff');
  t.mock.timers.tick(1);await settle();assert.equal(app.requests.length,baseline+2);
});

test('contextual selection and dismissal preserve navigation and in-flight requests', async t => {
  const app = await appFixture(t);
  const pending = deferred<Response>();
  app.setRead(() => pending.promise);
  const read = app.controller.refresh();
  await until(() => app.requests.length === 2, 'a refresh is in flight');
  const signal = app.requests.at(-1)!.signal!;
  app.overlay(5);
  await until(() => app.items().includes('テストスペース'), 'contextual Spaces should appear after the overlay closes');
  assert.equal(signal.aborted, false, 'overlay dismissal is not app backgrounding');
  // Protobuf omits zero-valued eventType and the first selected index.
  app.emit({ listEvent: { containerID: 3 } });
  await until(() => app.text().includes('テストカードの本文'), 'the next list tap should open the selected space');
  pending.resolve(response(fixture())); await read;
  app.emit({ sysEvent: { eventType: 3 } });
  await until(() => app.items().includes('テストスペース'), 'back from a card should open the space list');
  app.emit({ sysEvent: { eventType: 3 } });
  await until(() => app.items().includes('チャット'), 'back from spaces should open the root');
  app.overlay();
  app.emit({ listEvent: { containerID: 3, currentSelectItemIndex: 0 } });
  await until(() => app.text().includes('テストの返信'), 'closing the overlay without selecting an action must leave taps working');
});

test('ring, temple gestures and contextual actions keep working while the native phone view is hidden', async t => {
  const snapshot=fixture();
  snapshot.spaces[0]!.items[0]!.text=Array.from({length:14},(_,i)=>`背景操作の確認 ${i+1}`).join('\n');
  snapshot.spaces[0]!.items.push({id:'second-card',title:'次のカード',text:'スワイプ後の本文'});
  const app=await appFixture(t,snapshot);
  await app.controller.showSpace('test-space');
  const firstPage=app.text();
  app.document.hidden=true;app.document.dispatchEvent(new Event('visibilitychange'));
  app.emit({sysEvent:{eventSource:2}}); // Ring single tap; protobuf omits eventType=0.
  await until(()=>app.text()!==firstPage,'ring tap should advance the page in background');
  app.emit({textEvent:{eventType:2,containerID:1}});
  await until(()=>app.text().includes('スワイプ後の本文'),'text-container swipe should open the next card');
  const selectedCard=app.text();
  app.document.hidden=false;app.document.dispatchEvent(new Event('visibilitychange'));
  await settle();assert.equal(app.text(),selectedCard,'foreground return must retain the card and page');
  app.document.hidden=true;app.document.dispatchEvent(new Event('visibilitychange'));
  app.emit({sysEvent:{eventType:3,eventSource:1}});
  await until(()=>app.items().includes('テストスペース'),'right temple double tap should return to the spaces list');
  app.emit({listEvent:{containerID:3}});
  await until(()=>app.text().includes('背景操作の確認'),'list selection should still open the space');
  app.overlay(6);
  await until(()=>app.text().includes('テストの返信'),'contextual Chat should open while the phone is hidden');
  app.emit({sysEvent:{eventType:3,eventSource:3}});
  await until(()=>app.items().includes('チャット'),'left temple double tap should return to Home');
});

test('image download errors preserve relay connection and back leaves the failed image without retrying', async t => {
  const snapshot=fixture();snapshot.messages[0]!.image_file='synthetic.png';
  const app=await appFixture(t,snapshot);
  await assert.rejects(app.controller.showMessage('test-message'), /Image download HTTP 503/);
  assert.equal(app.controller.state.connected,true);
  assert.match(app.text(),/画像を取得できませんでした/);
  assert.equal(app.attachmentReads(),1);
  app.emit({sysEvent:{eventType:3}});
  await until(()=>app.items().includes('チャット'),'back should return to the home menu');
  assert.equal(app.attachmentReads(),1,'back must not act as a retry');
  assert.equal(app.controller.state.error,'');
});

test('downloaded images survive snapshot refreshes until their file or version changes', async t => {
  const snapshot=fixture();snapshot.messages[0]!.image_file='synthetic.png';
  const app=await appFixture(t,snapshot);
  app.setAttachment(async()=>new Response(JSON.stringify({mime:'image/png',name:'synthetic.png',data_base64:'c3ludGhldGlj'})));
  await app.controller.loadMessageImage('test-message');
  const downloaded=app.controller.state.snapshot.messages[0]!.image;
  await app.controller.saveSettings({...app.controller.state.settings,language:'de'});
  assert.equal(app.controller.state.connected,true,'a language change must not reset the relay connection');
  assert.equal(app.controller.state.snapshot.messages[0]!.image,downloaded,'a language change must retain downloaded images');
  await app.controller.refresh();
  assert.equal(app.controller.state.snapshot.messages[0]!.image,downloaded);
  await app.controller.loadMessageImage('test-message');
  assert.equal(app.attachmentReads(),1,'unchanged snapshots must reuse the downloaded attachment');
  snapshot.messages[0]!.ts++;
  await app.controller.refresh();
  assert.equal(app.controller.state.snapshot.messages[0]!.image,undefined,'a new version invalidates the attachment');
  await app.controller.loadMessageImage('test-message');
  assert.equal(app.attachmentReads(),2);
});

test('chat opens the latest message and phone read/hide actions survive refresh and can be undone', async t => {
  const snapshot=fixture();
  snapshot.messages=[
    {id:'middle',from:'Muse',type:'text',text:'middle',ts:20},
    {id:'oldest',from:'Muse',type:'text',text:'oldest',ts:10},
    {id:'latest',from:'Muse',type:'text',text:'latest',ts:30},
  ];
  const app=await appFixture(t,snapshot);
  app.emit({listEvent:{containerID:3}});
  await until(()=>app.text().includes('latest'),'Chat should open the newest timestamp');
  await app.controller.markRead(['middle','oldest','missing']);
  assert.ok(app.controller.state.readIds.includes('middle'));
  assert.ok(app.controller.state.readIds.includes('oldest'));
  assert.equal(app.controller.state.readIds.includes('missing'),false);
  await app.controller.hideMessages(['oldest','middle','missing']);
  await app.controller.refresh();
  assert.deepEqual(app.controller.state.hiddenIds,['oldest','middle']);
  assert.equal(app.controller.state.selectedMessageId,'latest');
  assert.equal(app.controller.state.snapshot.messages.length,3,'hiding never deletes relay messages');
  await app.controller.restoreHiddenMessages();
  assert.deepEqual(app.controller.state.hiddenIds,[]);
});

test('chat changes made while a preference save waits are kept and saved afterward', async t => {
  const app=await appFixture(t),pending=deferred<void>();
  let writes=0,lastStored='';
  app.bridge.setLocalStorage=async(_key,value)=>{writes++;if(writes===1)await pending.promise;lastStored=value;return true;};
  const preferenceSave=app.controller.saveSettings({...app.controller.state.settings,language:'de'});
  await until(()=>writes===1,'the preference save should be waiting for native storage');
  await app.controller.markRead(['test-message']);
  await app.controller.hideMessages(['test-message']);
  pending.resolve();await preferenceSave;
  assert.deepEqual(app.controller.state.readIds,['test-message']);
  assert.deepEqual(app.controller.state.hiddenIds,['test-message']);
  assert.deepEqual(JSON.parse(lastStored).readIds,['test-message']);
  assert.deepEqual(JSON.parse(lastStored).hiddenIds,['test-message']);
});

test('a batch of read messages retains existing read markers and can be retried after a storage failure', async t => {
  const snapshot=fixture();
  snapshot.messages=['read','unread-1','unread-2','hidden'].map((id,index)=>({id,from:'Muse',type:'text',text:id,ts:index+1}));
  const app=await appFixture(t,snapshot);
  await app.controller.hideMessages(['hidden']);
  const previous=['read',...Array.from({length:299},(_,i)=>`old-${i}`)];
  app.controller.state.readIds=previous;
  const writeLocal=localStorage.setItem,writeNative=app.bridge.setLocalStorage;
  localStorage.setItem=()=>{throw new Error('Synthetic storage failure');};
  app.bridge.setLocalStorage=async()=>false;
  const ids=['unread-1','unread-2','missing'];
  try {
    await assert.rejects(app.controller.markRead(ids),/Settings save failed/);
    assert.deepEqual(app.controller.state.readIds,previous);
  } finally {
    localStorage.setItem=writeLocal;app.bridge.setLocalStorage=writeNative;
  }
  await app.controller.markRead(ids);
  await app.controller.reloadSettings();
  assert.deepEqual(app.controller.state.readIds.slice(-3),['read','unread-1','unread-2']);
  assert.equal(app.controller.state.readIds.length,300);
  assert.deepEqual(app.controller.state.hiddenIds,['hidden']);
});

test('opening Chat with an empty saved and remote snapshot shows an explicit empty state', async t => {
  const app = await appFixture(t, { messages: [], spaces: [] });
  app.emit({ listEvent: { containerID: 3 } });
  await until(() => app.text().includes('メッセージはありません'), 'empty Chat must not become a blank idle page');
  app.emit({ sysEvent: { eventType: 3 } });
  await until(() => app.items().includes('チャット'), 'the empty state must have a working back gesture');
});

test('contextual refresh survives native background, retries failures, and aborts only on exit', async t => {
  const app = await appFixture(t);
  let pending = deferred<Response>();
  app.setRead(() => pending.promise);
  app.overlay(1);
  await until(() => app.text().includes('更新中'), 'manual refresh should show progress on glasses');
  pending.resolve(response(fixture()));
  await until(() => app.text().includes('更新しました'), 'successful refresh should be acknowledged');

  pending = deferred<Response>();
  app.setRead(() => pending.promise);
  app.overlay(1);
  await until(() => app.text().includes('更新中'), 'the next manual refresh should show progress');
  pending.resolve(new Response('{}', { status: 503 }));
  await until(() => /再試行|更新できません|更新に失敗|接続できません|HTTP 503/.test(app.text()), 'a failed refresh must be visible on glasses');
  const beforeRetry = app.requests.length;
  pending = deferred<Response>();
  app.setRead(() => pending.promise);
  app.emit({ sysEvent: {} });
  await until(() => app.requests.length > beforeRetry, 'tap on the error should retry the request');
  pending.resolve(response(fixture()));
  await until(() => app.text().includes('更新しました'), 'retry should recover without reopening the app');

  const holdUntilAborted = (options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic cancellation', 'AbortError')), { once: true });
  });
  pending=deferred<Response>();app.setRead(()=>pending.promise);
  const backgroundRead = app.controller.refresh();
  await settle();
  const backgroundSignal = app.requests.at(-1)!.signal!;
  app.document.hidden = true; app.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(backgroundSignal.aborted,false,'native phone background must not abort pending HTTP');
  pending.resolve(response(fixture()));
  await backgroundRead;
  app.setRead(async()=>response(fixture()));
  const whileHidden = app.requests.length; await app.controller.refresh();
  assert.equal(app.requests.length, whileHidden+1, 'native background must still accept refresh requests');

  app.document.hidden = false; app.document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  app.setRead(holdUntilAborted);
  const exitRead = app.controller.refresh();
  await settle();
  const exitSignal = app.requests.at(-1)!.signal!;
  app.emit({ sysEvent: { eventType: 7 } });
  await until(() => exitSignal.aborted, 'system exit should abort pending HTTP');
  await exitRead;
  const afterExit = app.requests.length; await app.controller.refresh();
  assert.equal(app.requests.length, afterExit, 'system exit must stop further reads');
});

test('a queued list rebuild cannot leave a stale text layout that upgrades a missing container', async () => {
  const display = fakeDisplay(), firstRebuild = deferred<boolean>(), started = deferred<void>();
  const rebuild = display.bridge.rebuildPageContainer;
  let first = true;
  display.bridge.rebuildPageContainer = async page => {
    if (first) { first = false; started.resolve(); await firstRebuild.promise; }
    return rebuild(page);
  };
  const glasses = new Glasses(() => {});
  glasses.bridge = display.bridge as unknown as EvenAppBridge; glasses.ready = true;
  const state = { settings: { ...defaults, language: 'ja' } } as AppState;
  const text = glasses.show(state, 'テスト本文');
  await started.promise;
  const list = glasses.list(state, ['チャット']);
  firstRebuild.resolve(true); await Promise.all([text, list]);
  await glasses.show(state, 'チャットの本文');
  assert.equal(display.operations.includes('upgrade:missing'), false, 'the text page needs rebuilding after the list');
  assert.match(display.text(), /チャットの本文/);

  const overlayDisplay = fakeDisplay(), blocked = deferred<void>(), entered = deferred<void>();
  const overlayRebuild = overlayDisplay.bridge.rebuildPageContainer;
  let blocking = true;
  overlayDisplay.bridge.rebuildPageContainer = async page => {
    if (blocking) { blocking = false; entered.resolve(); await blocked.promise; }
    return overlayRebuild(page);
  };
  const overlayGlasses = new Glasses(() => {});
  overlayGlasses.bridge = overlayDisplay.bridge as unknown as EvenAppBridge; overlayGlasses.ready = true;
  const activeDraw = overlayGlasses.show(state, 'テスト本文');
  await entered.promise;
  const queuedList = overlayGlasses.list(state, ['チャット']);
  overlayGlasses.invalidateRender();
  blocked.resolve(); await Promise.all([activeDraw, queuedList]);
  assert.equal(overlayDisplay.operations.includes('rebuild:list'), false, 'opening an overlay should discard a queued list rebuild');
  await overlayGlasses.show(state, 'メニューを閉じた後の本文');
  assert.match(overlayDisplay.text(), /メニューを閉じた後の本文/);
  assert.equal(overlayDisplay.operations.includes('upgrade:missing'), false);
});

test('native background preserves microphone startup while ring cancellation and system exit close it', async t => {
  const app = await appFixture(t);
  const calls: boolean[] = [];
  let opening = deferred<void>();
  app.bridge.audioControl = async (open = false) => {
    calls.push(open);
    if (open) await opening.promise;
    return true;
  };
  const deadlines = new Set<ReturnType<typeof setTimeout>>(), cleared = new Set<ReturnType<typeof setTimeout>>();
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 30000) deadlines.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => {
    if (deadlines.has(timer)) cleared.add(timer);
    return cancel(timer);
  });

  app.emit({ sysEvent: { eventType: 9 } });
  await until(() => calls.length === 1, 'the microphone open call should be waiting');
  app.document.hidden = true; app.document.dispatchEvent(new Event('visibilitychange'));
  opening.resolve();
  await until(() => app.controller.state.recording&&!app.controller.state.busy, 'microphone startup should finish in native background');
  assert.deepEqual(calls,[true],'phone background must not close the glasses microphone');
  app.emit({sysEvent:{eventType:3,eventSource:2}});
  await until(() => calls.length === 2 && app.controller.state.recording === false, 'ring double tap should cancel in background');
  assert.deepEqual(calls, [true, false]);
  assert.equal([...deadlines].every(timer => cleared.has(timer)), true, 'the cancelled recording deadline must be cleared');

  app.document.hidden = false; app.document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  opening = deferred<void>();
  app.emit({ sysEvent: { eventType: 9 } });
  await until(() => calls.length === 3, 'a second microphone open call should be waiting');
  app.emit({ sysEvent: { eventType: 7 } });
  opening.resolve();
  await until(() => calls.length === 4 && app.controller.state.recording === false, 'system exit cancellation must complete after microphone startup resolves');
  assert.deepEqual(calls, [true, false, true, false]);
  assert.equal(deadlines.size, 2, 'both recordings should have reached their deadline setup');
  assert.equal(cleared.size, deadlines.size, 'no recording deadline should survive either exit path');
});
