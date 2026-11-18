import test from 'node:test';
import assert from 'node:assert/strict';
import { GistRelay } from '../src/relay/gist.ts';
import { GadgetRelay } from '../src/relay/gadget.ts';
import { SonioxStream, checkSonioxConnection } from '../src/core/soniox.ts';
import { defaults, endpoint, gistId, resolveSonioxConnection, validateSettings } from '../src/core/config.ts';
import { parseSnapshot } from '../src/relay/protocol.ts';
import { wav } from '../src/core/media.ts';
import { Glasses } from '../src/core/glasses.ts';
import { decodeSavedState, LOCAL_STATE_KEY, StateStorage, type SavedState } from '../src/core/persistence.ts';
import { resolveLocale, speechLanguage } from '../src/core/i18n.ts';
import { ReplyPoll } from '../src/core/reply-poll.ts';
import {parseSpaceControl} from '../protocol/space-controls.mjs';
import { chatEntries, chatExchange, chatText, displayableMuseReply } from '../src/core/chat.ts';
import type { Message, Settings } from '../src/core/types.ts';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

test('chat pairs explicit replies and voice transcripts without borrowing unrelated or hidden inputs',()=>{
  const messages:Message[]=[
    {id:'a',from:'You',type:'voice-note',text:'[Voice note]',ts:1},
    {id:'b',from:'You',type:'text',text:'別の質問',ts:2},
    {id:'answer-a',from:'Muse',type:'text',text:'最初の回答',reply_to:'a',ts:3},
    {id:'transcript-a',from:'You',type:'text',text:'最初に話した内容',reply_to:'a',ts:4},
  ];
  assert.equal(chatExchange(messages,'answer-a')?.input.id,'transcript-a');
  assert.equal(chatExchange(messages,'a')?.reply?.id,'answer-a');
  assert.equal(chatExchange(messages,'b')?.reply,undefined,'a late reply to a different request must not pair');
  assert.equal(chatExchange(messages.filter(m=>m.from!=='You'||m.id==='b'),'answer-a'),undefined);
  assert.deepEqual(chatEntries(messages).map(m=>m.id),['b','answer-a'],'paired inputs and transcript aliases do not cause identical swipe pages');
  const legacy:Message={id:'legacy',from:'Muse',type:'text',text:'以前の形式',ts:5};
  assert.equal(chatExchange([...messages.slice(0,2),legacy],'legacy',{legacy:true})?.input.id,'b');
  assert.equal(chatExchange([...messages,legacy],'legacy',{legacy:true}),undefined,'mixed modern feeds must not infer the input of independent posts');
  assert.equal(chatExchange([...messages.slice(0,2),legacy],'legacy'),undefined,'Gadget posts without reply IDs stay independent');
  const sameTime=[{...messages[3]!,ts:1},{...messages[0]!,text:'音声を送信'},messages[2]!];
  assert.equal(chatExchange(sameTime,'answer-a')?.input.text,'最初に話した内容','an explicit transcript alias beats an appended local placeholder');
  assert.equal(chatText({...messages[0]!,text:'話した内容\n[file:audio/wav abc]'}),'話した内容');
  assert.equal(chatText(messages[0]!), '');
  assert.equal(displayableMuseReply(messages[2]!,false),true);
  assert.equal(displayableMuseReply({...messages[2]!,from:'Relay'},true),false);
  assert.equal(displayableMuseReply({...messages[2]!,from:'You'},true),false);
  assert.equal(displayableMuseReply({...messages[2]!,id:'status_a'},true),false);
  assert.equal(displayableMuseReply({...messages[0]!,from:'Muse'},true),false);
  const image:Message={id:'image',from:'Muse',type:'image',text:'',image_file:'answer.png',ts:5};
  assert.equal(displayableMuseReply(image,false),false);assert.equal(displayableMuseReply(image,true),true);
});

test('space exports preserve declarative controls and disable invalid or unknown widgets',()=>{
  const snapshot=parseSnapshot({messages:[],spaces:[{id:'s',title:'Space',items:[
    {id:'a',title:'Slider',text:'',control:{type:'slider',min:0,max:1,step:0.1,value:0.3}},
    {id:'b',title:'Broken',text:'',control:{type:'slider',min:0,max:10,step:0,value:4}},
    {id:'c',title:'Unknown',text:'Still readable',control:{type:'script',url:'https://example.test'}},
  ]}]});
  assert.equal(snapshot.spaces[0]!.layout,'list');
  assert.equal(snapshot.spaces[0]!.items[0]!.control?.type,'slider');
  assert.deepEqual(snapshot.spaces[0]!.items[1]!.control,{type:'unsupported',disabled:true});
  assert.equal(snapshot.spaces[0]!.items[2]!.text,'Still readable');
  assert.throws(()=>parseSpaceControl({type:'choice',options:[{id:'x',title:'A'},{id:'x',title:'B'}]}));
});

test('reply polling follows only sent requests, keeps partial replies fast, and has a fixed deadline',()=>{
  const poll=new ReplyPoll();
  const reply=(request:string,text:string)=>({id:`reply-${request}`,reply_to:request,from:'Muse',type:'text' as const,text,ts:1});
  assert.equal(poll.delay(15000,0),15000);
  poll.sent('sent',0);
  poll.observe([reply('another','unrelated')],1000);
  assert.equal(poll.delay(15000,7000),1000,'unrelated messages must not finish the wait');
  poll.observe([reply('sent','partial')],8000);
  poll.observe([reply('sent','partial continued')],12000);
  assert.equal(poll.delay(15000,16999),1000,'a partial update extends the quiet window');
  assert.equal(poll.delay(15000,17000),15000);
  poll.sent('first',20000);poll.sent('second',21000);
  poll.observe([reply('first','done')],22000);
  assert.equal(poll.delay(15000,27000),1000,'a second outstanding request keeps receiving quickly');
  assert.equal(poll.delay(15000,141000),15000,'no response must not keep fast polling indefinitely');
  poll.sent('stream',150000);
  poll.observe([reply('stream','still changing')],269999);
  assert.equal(poll.delay(15000,270000),15000,'streaming cannot extend the two-minute limit');
});

test('phone language selection preserves explicit settings and keeps locale tags out of speech hints',()=>{
  assert.equal(resolveLocale('system',['pt-BR','zh-HK','en']),'zh-Hant');
  assert.equal(resolveLocale('system',['zh-Hans-TW']),'zh-Hans');
  assert.equal(resolveLocale('system',['fr-CA']),'fr');
  assert.equal(resolveLocale('ja',['en-US']),'ja');
  assert.equal(speechLanguage('zh-Hant'),'zh');
  const saved={settings:{...defaults,language:'retired-locale',speakerFilter:'retired-filter',relayToken:'synthetic-preserved-token'},snapshot:{messages:[],spaces:[]}};
  const restored=decodeSavedState(JSON.stringify(saved));
  assert.equal(restored?.settings.language,'system');
  assert.equal(restored?.settings.speakerFilter,'all');
  assert.equal(restored?.settings.relayToken,'synthetic-preserved-token','unsupported language must not discard connection settings');
  saved.settings.language='ja';
  assert.equal(decodeSavedState(JSON.stringify(saved))?.settings.language,'ja');
});

test('Gist accepts legacy messages, caches 304, and writes a separate immutable request',async()=>{
  const original=globalThis.fetch;const calls:Array<{url:string,options?:RequestInit}>=[];
  globalThis.fetch=async(input,options)=>{
    calls.push({url:String(input),options});
    if(options?.method==='PATCH')return new Response('{}');
    if(calls.length===2)return new Response(null,{status:304});
    return new Response(JSON.stringify({files:{'g2muse-relay.json':{content:JSON.stringify({messages:[{id:'m1',from:'Muse',type:'text',text:'今日の予定',ts:123},{id:'m2',from:'Muse',type:'image',image_file:'muse-image.base64',mime_type:'image/png',ts:124}]})},
      'muse-image.base64':{content:'AAAA'},
      'muse-relay-profile.json':{content:JSON.stringify({profile:{name:'Test Muse',avatar_file:'muse-image.base64',mime_type:'image/png',updated_at:124}})},
      'muse-relay-spaces.json':{content:JSON.stringify({spaces:[{id:'news',title:'ニュース',items:[{id:'a',title:'更新',text:'本文'}]}]})}}}),{headers:{etag:'"revision-1"'}});
  };
  try{
    const relay=new GistRelay({...defaults,gistId:'a'.repeat(32),githubToken:'test-only-token'});
    const first=await relay.read();assert.equal(first.messages[0]?.text,'今日の予定');assert.equal(first.spaces.length,1);
    assert.deepEqual(await relay.read(),first);
    assert.equal(first.messages[1]?.image_file,'muse-image.base64');
    assert.equal(first.profile?.name,'Test Muse');assert.equal(first.profile?.avatar_file,'muse-image.base64');
    assert.equal((await relay.attachment('muse-image.base64','image/png')).data_base64,'AAAA');
    await relay.send({id:'test_one',kind:'chat',text:'確認',created_at:123,audio:{mime:'audio/wav',name:'voice.wav',data_base64:'AAAA'}});
    const patch=JSON.parse(String(calls.at(-1)?.options?.body));
    assert.equal(patch.files['g2muse-relay.json'],undefined,'outbound must not replace another writer’s message list');
    const request=JSON.parse(patch.files['muse-relay-request-test_one.json'].content);
    assert.equal(request.audio_file,'muse-relay-audio-test_one.base64');
    assert.equal(request.audio_mime,'audio/wav');assert.equal(request.audio,undefined);
  }finally{globalThis.fetch=original;}
});

test('incoming Gadget images remain readable when image uploads are disabled',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(input)=>new Response(JSON.stringify(String(input).endsWith('/v1/snapshot')
    ?{messages:[{id:'muse_export_image',from:'Muse',type:'image',image_file:'received.png',ts:1}],spaces:[],capabilities:{audio:true,images:false,spaces:true}}
    :{mime:'image/png',name:'received.png',data_base64:'AAAA'}));
  try{
    const relay=new GadgetRelay({...defaults,relay:'gadget',relayUrl:'https://relay.example.com',relayToken:'test-only'});
    const snapshot=await relay.read();assert.equal(snapshot.capabilities?.images,false);
    const message=snapshot.messages[0]!;assert.equal(message.type,'image');assert.equal(message.text,'');
    assert.equal((await relay.attachment(message.image_file!,'image/png')).data_base64,'AAAA');
  }finally{globalThis.fetch=original;}
});

test('optional avatar parsing accepts image bytes and keeps invalid profile images from breaking chats',()=>{
  const value={messages:[{id:'ok',from:'Muse',text:'Hello',ts:1}],spaces:[],profile:{name:'Test Muse',avatar:{mime:'image/png',data_base64:'AAAA',name:'avatar.png'}}};
  assert.equal(parseSnapshot(value).profile?.avatar?.mime,'image/png');
  for(const avatar of [{mime:'audio/wav',data_base64:'AAAA'},{mime:'image/svg+xml',data_base64:'AAAA'},{mime:'image/png',data_base64:'A'.repeat(333340)}]){
    const parsed=parseSnapshot({...value,profile:{...value.profile,avatar}});
    assert.equal(parsed.messages[0]?.text,'Hello');assert.equal(parsed.profile?.avatar,undefined);
  }
});

test('boundaries reject unsafe endpoints and preserve WAV PCM metadata',()=>{
  assert.equal(gistId(`https://gist.github.com/name/${'b'.repeat(32)}`),'b'.repeat(32));
  assert.throws(()=>endpoint('https://user:password@example.com'));assert.throws(()=>endpoint('http://192.168.1.2'));
  assert.equal(endpoint('http://127.0.0.1:8787/'),'http://127.0.0.1:8787');
  const bytes=wav([new Uint8Array([1,2,3,4])]);const view=new DataView(bytes.buffer);
  assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(40,true),4);
  assert.deepEqual([...bytes.slice(44)],[1,2,3,4]);
  const snapshot=parseSnapshot({messages:[{id:'x',from:'Muse',text:'a',ts:1},{id:'x',from:'Muse',text:'duplicate',ts:1}]});
  assert.equal(snapshot.messages.length,1);
});


test('hosting credentials stay on their configured HTTP endpoint and out of GitHub and Soniox sockets',async()=>{
  const originalFetch=globalThis.fetch,originalSocket=globalThis.WebSocket;
  const calls:Array<{url:string,options?:RequestInit}>=[];
  const sockets:Array<{url:string,protocols:string[],sent:unknown[]}>=[];
  class FakeSocket {
    static OPEN=1;
    onopen?:()=>void;
    onclose?:()=>void;
    onerror?:()=>void;
    onmessage?:()=>void;
    readyState=1;
    bufferedAmount=0;
    sent:unknown[]=[];
    constructor(url:string,protocols:string[]){sockets.push({url,protocols,sent:this.sent});queueMicrotask(()=>this.onopen?.());}
    send(value:unknown){this.sent.push(value);}
    close(){this.readyState=3;this.onclose?.();}
  }
  globalThis.WebSocket=FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch=async(input,options)=>{
    const url=String(input);calls.push({url,options});
    if(url.startsWith('https://api.github.com/'))return new Response(JSON.stringify({files:{'g2muse-relay.json':{content:'{"messages":[]}'}}}));
    if(url.startsWith('https://speech.example.com/')||url.endsWith('/v1/soniox-token'))return new Response('{"api_key":"snx_temp_test-only"}');
    return new Response('{"messages":[],"spaces":[]}');
  };
  const settings={...defaults,relay:'gadget' as const,relayUrl:'https://relay.example.com',relayToken:'phone-test',gatewayToken:'relay-hosting-test',
    sonioxTokenUrl:'https://speech.example.com/key',sonioxTokenAuth:'speech-endpoint-test',sonioxGatewayToken:'speech-hosting-test'};
  const stream=new SonioxStream(()=>{},()=>{}),withoutGateway=new SonioxStream(()=>{},()=>{}),automatic=new SonioxStream(()=>{},()=>{});
  try{
    const relay=new GadgetRelay(settings);await relay.read();
    await relay.send({id:'headers-only',kind:'chat',text:'test',created_at:1});
    for(const call of calls){const headers=new Headers(call.options?.headers);assert.equal(headers.get('Authorization'),'Bearer phone-test');assert.equal(headers.get('OAI-Sites-Authorization'),'Bearer relay-hosting-test');assert.equal(call.options?.redirect,'error');}
    await new GadgetRelay({...settings,gatewayToken:''}).read();
    assert.equal(new Headers(calls.at(-1)?.options?.headers).has('OAI-Sites-Authorization'),false);
    await new GistRelay({...settings,gistId:'a'.repeat(32),githubToken:'github-test'}).read();
    assert.equal(new Headers(calls.at(-1)?.options?.headers).has('OAI-Sites-Authorization'),false);
    await stream.start(settings);
    const keyRequest=calls.at(-1)!;assert.equal(keyRequest.url,'https://speech.example.com/key');
    const keyHeaders=new Headers(keyRequest.options?.headers);
    assert.equal(keyHeaders.get('OAI-Sites-Authorization'),'Bearer speech-hosting-test');
    assert.equal(keyHeaders.get('Authorization'),'Bearer speech-endpoint-test');assert.equal(keyRequest.options?.redirect,'error');
    await withoutGateway.start({...settings,sonioxGatewayToken:''});
    assert.equal(new Headers(calls.at(-1)?.options?.headers).has('OAI-Sites-Authorization'),false,'do not reuse the relay hosting key');
    const autoSettings=validateSettings({...settings,voice:'soniox',sonioxTokenUrl:'',sonioxTokenAuth:'',sonioxGatewayToken:''});
    assert.equal(autoSettings.sonioxTokenUrl,'','automatic routing must remain automatic after saving');
    await automatic.start(autoSettings);
    const autoRequest=calls.at(-1)!;assert.equal(autoRequest.url,'https://relay.example.com/v1/soniox-token');
    assert.equal(new Headers(autoRequest.options?.headers).get('Authorization'),'Bearer phone-test');
    assert.equal(new Headers(autoRequest.options?.headers).get('OAI-Sites-Authorization'),'Bearer relay-hosting-test');
    assert.deepEqual(resolveSonioxConnection({...autoSettings,relayUrl:'https://new-relay.example.com',relayToken:'new-phone',gatewayToken:'new-hosting'}),
      {mode:'token-server',url:'https://new-relay.example.com/v1/soniox-token',token:'new-phone',gatewayToken:'new-hosting',usesRelay:true});
    const custom=resolveSonioxConnection({...autoSettings,sonioxTokenUrl:'https://other.example.com/key'});
    assert.equal(custom.token,'');assert.equal(custom.gatewayToken,'','custom origins must never inherit relay credentials');
    assert.throws(()=>resolveSonioxConnection({...autoSettings,relay:'gist'}),'a new Gist setup requires the personal key instead');
    assert.equal(parseSnapshot({messages:[],capabilities:{soniox:false}}).capabilities?.soniox,false);
    assert.equal(parseSnapshot({messages:[],capabilities:{}}).capabilities?.soniox,undefined,'older servers are unconfirmed, not configured');
    for(const socket of sockets){assert.equal(socket.url,'wss://stt-rt.soniox.com/transcribe-websocket');assert.deepEqual(socket.protocols,['soniox-api-key','snx_temp_test-only']);}
    assert.doesNotMatch(JSON.stringify(sockets),/relay-hosting-test|speech-hosting-test|speech-endpoint-test|phone-test/);
  }finally{stream.cancel();withoutGateway.cancel();automatic.cancel();globalThis.fetch=originalFetch;globalThis.WebSocket=originalSocket;}
});

const savedFixture = (): SavedState => ({ settings: { ...defaults, relay: 'gadget', relayUrl: 'https://relay.example.com', relayToken: 'test-only-connection', configured: true },
  snapshot: { messages: [], spaces: [] }, readIds: [], hiddenIds: [], selectedSpaceIds: ['test-space'] });
function localMemory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test('settings survive a stalled/failed G2 startup and reopening even with a damaged message cache', async () => {
  const local = localMemory();
  const legacy = JSON.parse(JSON.stringify({ ...savedFixture(), snapshot: { broken: true } }));
  delete legacy.settings.speakerFilter;
  let native = JSON.stringify(legacy);
  let releaseStartup!: (code: number) => void, started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const bridge = { onEvenHubEvent: () => () => {}, getLocalStorage: async () => native,
    setLocalStorage: async (_key: string, value: string) => { native = value; return true; },
    createStartUpPageContainer: () => { started(); return new Promise<number>(resolve => { releaseStartup = resolve; }); } } as unknown as EvenAppBridge;
  const glasses = new Glasses(() => {}, async () => bridge);
  const storage = new StateStorage(local, glasses);
  const loaded = await storage.load();
  assert.equal(loaded.value?.settings.relayToken, 'test-only-connection');
  assert.deepEqual(loaded.value?.snapshot.messages, []);
  const startup = glasses.start().then(() => null, error => error);
  await startedPromise;
  assert.equal(loaded.value?.settings.autoHideSeconds,0);
  assert.equal(loaded.value?.settings.returnToChatAfterSend,true);
  assert.equal(loaded.value?.settings.chatLayout,'exchange');
  assert.equal(loaded.value?.settings.speakerFilter,'all','existing settings keep all audio unchanged');
  const next = { ...loaded.value!, settings: { ...loaded.value!.settings, language: 'en' as const, autoHideSeconds:20, returnToChatAfterSend:false, chatLayout:'single' as const, speakerFilter:'self' as const } };
  assert.equal(await storage.save(next, true), 'native', 'native storage must not wait for the stalled G2 request');
  releaseStartup(2); assert.match(String(await startup), /G2 startup/);
  await storage.save({ ...next, settings: { ...defaults } });
  assert.equal(JSON.parse(native).settings.relayToken, 'test-only-connection', 'automatic cache saves cannot replace credentials');
  const reopened = await new StateStorage(local, new Glasses(() => {}, async () => bridge)).load();
  assert.equal(reopened.value?.settings.language, 'en'); assert.equal(reopened.value?.settings.configured, true);
  assert.equal(reopened.value?.settings.autoHideSeconds,20); assert.equal(reopened.value?.settings.returnToChatAfterSend,false);
  assert.equal(reopened.value?.settings.chatLayout,'single');
  assert.equal(reopened.value?.settings.speakerFilter,'self');
  assert.deepEqual(reopened.value?.selectedSpaceIds, ['test-space']);
  await storage.save({ ...savedFixture(), settings: { ...defaults }, selectedSpaceIds: [] }, true);
  assert.equal(JSON.parse(native).settings.relayToken, '');
  assert.equal(JSON.parse(local.getItem(LOCAL_STATE_KEY)!).settings.relayToken, '');
});

test('a late native read cannot overwrite a save and backup-only saves remain distinguishable', async () => {
  const local = localMemory(); let resolveRead!: (raw: string) => void; let writes = 0;
  const old = JSON.stringify(savedFixture());
  const storage = new StateStorage(local, { load: () => new Promise(resolve => { resolveRead = resolve; }), save: async () => { writes++; } }, () => 100);
  const pending = storage.load();
  assert.equal(await storage.save({ ...savedFixture(), settings: { ...defaults } }), null);
  assert.equal(writes, 0); assert.equal(local.getItem(LOCAL_STATE_KEY), null, 'no default writes before restore');
  const edited = { ...savedFixture(), settings: { ...savedFixture().settings, relayToken: 'test-only-new-connection' } };
  assert.equal(await storage.save(edited, true), 'native');
  resolveRead(old); assert.equal((await pending).stale, true);
  const backup = new StateStorage(local, { load: async () => old, save: async () => { throw new Error('native unavailable'); } }, () => 200);
  assert.equal((await backup.load()).value?.settings.relayToken, 'test-only-new-connection');
  assert.equal(await backup.save({ ...edited, selectedSpaceIds: ['new-space'] }, true), 'local');
  const reopened = await new StateStorage(local, { load: async () => { throw new Error('offline'); }, save: async () => {} }).load();
  assert.equal(reopened.mode, 'local'); assert.equal(reopened.failed, true);
  assert.equal(reopened.value?.settings.relayToken, 'test-only-new-connection'); assert.deepEqual(reopened.value?.selectedSpaceIds, ['new-space']);
});

test('Soniox direct keys bypass token endpoints and preserve legacy server selection',async()=>{
  const {sonioxAuthMode}=await import('../src/core/config.ts');
  const old={...defaults,sonioxAuth:undefined,sonioxApiKey:undefined,relay:'gadget' as const,relayUrl:'https://relay.example.com',relayToken:'phone-test',voice:'soniox' as const};
  const migrated=validateSettings(old as unknown as Settings);
  assert.equal(sonioxAuthMode(migrated),'token-server');
  assert.equal(sonioxAuthMode({...migrated,relay:'gist',sonioxTokenUrl:'https://speech.example.com/token'}),'token-server');
  assert.equal(sonioxAuthMode({...migrated,relay:'gist',sonioxTokenUrl:''}),'api-key');
  const direct=validateSettings({...migrated,relay:'gist',gistId:'a'.repeat(32),githubToken:'github-test',sonioxAuth:'api-key',sonioxApiKey:'personal-test-key',sonioxTokenUrl:'not a URL'});
  assert.equal(direct.sonioxApiKey,'personal-test-key');
  assert.equal(decodeSavedState(JSON.stringify({...savedFixture(),settings:{...direct,configured:true}}))?.settings.sonioxApiKey,'personal-test-key');
  const oldFetch=globalThis.fetch,oldSocket=globalThis.WebSocket;
  const sent:unknown[]=[];let protocols:string[]=[];
  class Socket {
    static OPEN=1; readyState=1;bufferedAmount=0; onopen?:()=>void;onclose?:()=>void;onmessage?:(e:{data:string})=>void;
    constructor(url:string,p:string[]){assert.equal(url,'wss://stt-rt.soniox.com/transcribe-websocket');protocols=p;queueMicrotask(()=>this.onopen?.());}
    send(value:unknown){sent.push(value);if(value==='')queueMicrotask(()=>this.onmessage?.({data:'{"finished":true}'}));}
    close(){this.readyState=3;this.onclose?.();}
  }
  globalThis.fetch=async()=>{throw new Error('direct authentication must not call a relay/token server');};
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;
  try {await checkSonioxConnection(direct);assert.deepEqual(protocols,['soniox-api-key','personal-test-key']);assert.doesNotMatch(JSON.stringify(sent),/personal-test-key|github-test|phone-test/);assert.equal((sent[1] as ArrayBuffer).byteLength,32000);}
  finally {globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;}
});

test('Soniox connection check rejects an authentication error after the socket opens',async()=>{
  const oldSocket=globalThis.WebSocket;
  class Socket {
    static OPEN=1;readyState=1;bufferedAmount=0;onopen?:()=>void;onclose?:()=>void;onmessage?:(e:{data:string})=>void;
    constructor(){queueMicrotask(()=>{this.onopen?.();queueMicrotask(()=>this.onmessage?.({data:'{"error_code":401,"error_type":"invalid_api_key"}'}));});}
    send(){} close(){this.readyState=3;this.onclose?.();}
  }
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;
  try {await assert.rejects(checkSonioxConnection({...defaults,sonioxAuth:'api-key',sonioxApiKey:'invalid-test-key'}),/Soniox 401/);}
  finally {globalThis.WebSocket=oldSocket;}
});

test('Soniox drains recorded audio at its PCM pace and queues newer audio behind it',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  const sent:Array<{value:string|ArrayBuffer;time:number}>=[];
  let socket:Socket|undefined;
  class Socket {
    static OPEN=1;
    readyState=0;bufferedAmount=0;
    onopen?:()=>void;
    onmessage?:(event:{data:string})=>void;
    onclose?:()=>void;
    constructor(){socket=this;}
    open(){this.readyState=1;this.onopen?.();}
    send(value:string|ArrayBuffer){
      sent.push({value,time:Date.now()});
      if(value==='')this.onmessage?.({data:'{"finished":true}'});
    }
    close(){this.readyState=3;this.onclose?.();}
  }
  const prior=globalThis.WebSocket;
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;
  const stream=new SonioxStream(()=>{},()=>{});
  try{
    const opening=stream.start({...defaults,sonioxAuth:'api-key',sonioxApiKey:'synthetic-direct'});
    stream.push(new Uint8Array(6400).fill(1));
    assert.equal(sent.length,0);
    socket!.open();await opening;
    stream.push(new Uint8Array(3200).fill(2));
    const finishing=stream.finish();
    assert.equal(sent.length,2,'only the configuration and first 100 ms of audio are sent immediately');
    for(let i=0;i<3;i++){t.mock.timers.tick(100);await new Promise<void>(resolve=>setImmediate(resolve));}
    await finishing;
    assert.deepEqual(sent.slice(1).map(({value,time})=>[typeof value==='string'?value:new Uint8Array(value)[0],time]),[[1,0],[1,100],[2,200],['',300]]);
  }finally{stream.cancel();globalThis.WebSocket=prior;}
});

test('Muse requests follow the selected voice route, keep credentials private and separate optional work',async()=>{
  const {museSetupPrompt,spacePrompt,avatarPrompt}=await import('../src/ui/prompts.ts');
  for(const relay of ['gist','gadget'] as const)for(const voice of ['muse','soniox'] as const)for(const sonioxAuth of ['api-key','token-server'] as const){
    const settings={...defaults,relay,voice,sonioxAuth,sonioxApiKey:'DO-NOT-COPY-PERSONAL-KEY',relayUrl:'https://private.example.test',relayToken:'DO-NOT-COPY-RELAY',githubToken:'DO-NOT-COPY-GITHUB',sonioxTokenUrl:'https://private-speech.example.test',speakerFilter:'self' as const};
    const setup=museSetupPrompt(settings),space=spacePrompt(settings,{name:'Notes',purpose:'Take notes',layout:'list',controls:['microphone']}),avatar=avatarPrompt(settings);
    for(const prompt of [setup,space,avatar])assert.doesNotMatch(prompt,/DO-NOT-COPY|private.example|private-speech.example/);
    assert.match(setup,/Spaces are optional/);assert.doesNotMatch(setup,/Finish with one text reply and one selected space/);
    assert.match(space,/reply_to/);assert.match(space,/only the wearer/);assert.match(avatar,/do not create, generate or choose a replacement/);
    if(voice==='soniox'){
      assert.match(space,/do not transcribe it again/);
      if(sonioxAuth==='api-key'){assert.match(setup,/Do not build or require a token server/);assert.doesNotMatch(setup,/Keep the long-term Soniox key on/);}
      else assert.match(setup,/Reuse the selected custom endpoint/);
    } else {
      assert.match(setup,/16kHz, 16-bit mono WAV/);assert.match(setup,/Soniox setup is not required/);
      if(relay==='gadget'){
        assert.match(setup,/custom relay already transcribes WAV on the server/);
        assert.match(setup,/id equal to the request id/);
        assert.match(space,/use its configured transcriber/);
      }
    }
  }
});
