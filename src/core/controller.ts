import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { ImuReportPace, AudioInputSource, AudioSpeakerRole } from '@evenrealities/even_hub_sdk';
import { getTextWidth } from '@evenrealities/pretext';
import type { AppController, AppState, Attachment, Message, Relay, RelayRequest, Settings, SpaceItem, SpaceControl, MuseProfile } from './types';
import { defaults, validateSettings } from './config';
import { GistRelay } from '../relay/gist';
import { GadgetRelay } from '../relay/gadget';
import { Glasses, glassBodyRows, type GlassMenuItem, type GlassTextStyle } from './glasses';
import { excerpt, G2_TEXT_LIMIT, paginate, wrapLines } from './glass-text';
import { base64, resizeImage, wav } from './media';
import { RelayVoiceSession, SonioxStream } from './soniox';
import { LOCAL_STATE_KEY, StateStorage, type SavedState } from './persistence';
import { resolveLocale, translate } from './i18n';
import { HeadRaise, headPitch } from './head-wake';
import { ReplyPoll } from './reply-poll';
import { matchesSpaceAction, sliderValue } from '../../protocol/space-controls.mjs';
import { chatEntries, chatExchange, chatText, displayableMuseReply } from './chat';

type GlassPage={body:string;footer:string;image?:boolean};
interface ChatPage {
  body: string;
  footer: string;
  messageId?: string;
  photo?: Message;
  style?: GlassTextStyle;
  readReplyId?: string;
}

const trackAt=(position:number,slots:number)=>`[${'-'.repeat(position)}O${'-'.repeat(slots-position-1)}]`;
const sliderSlots=(()=>{
  let slots=1;
  // An odd track has an exact middle cell; its total width never depends on the value.
  for(let candidate=3;candidate+2<=G2_TEXT_LIMIT;candidate+=2){
    if([0,(candidate-1)/2,candidate-1].some(position=>getTextWidth(trackAt(position,candidate))>576))break;
    slots=candidate;
  }
  return slots;
})();
function sliderTrack(value:number,min:number,max:number):string{
  const position=Math.max(0,Math.min(sliderSlots-1,Math.round((value-min)/(max-min)*(sliderSlots-1))));
  return trackAt(position,sliderSlots);
}

/** Count and fill pages together: a translated final-page hint can use different rows. */
function bodyPages(body:string,footer:(index:number,total:number)=>string,input?:string,image=false):GlassPage[]{
  const lines=wrapLines(body),offset=image?1:0;
  const maxRows=glassBodyRows('',input),minimum=paginate(body,maxRows).length;
  for(let count=minimum;count<=lines.length;){
    const total=count+offset,pages:GlassPage[]=image?[{body:'',footer:footer(0,total),image:true}]:[];
    let cursor=0;
    for(let index=0;index<count;index++){
      const hint=footer(index+offset,total),rows=glassBodyRows(hint,input);
      // Reserve one complete line for every remaining page, including the final hint.
      const limit=Math.min(cursor+rows,lines.length-(count-index-1));
      const content:string[]=[];let length=0;
      while(cursor<limit){
        const line=lines[cursor]!,added=line.length+(content.length?1:0);
        if(content.length&&length+added>G2_TEXT_LIMIT)break;
        content.push(line);length+=added;cursor++;
      }
      pages.push({body:content.join('\n'),footer:hint});
    }
    if(cursor===lines.length)return pages;
    if(count===lines.length)break;
    // Long transcripts may contain thousands of hard lines; avoid trying every count.
    count=Math.min(lines.length,count+Math.max(1,Math.ceil((lines.length-cursor)/maxRows)));
  }
  throw new Error('G2 text pagination');
}

export function createController(options:{bridgeFactory?:()=>Promise<EvenAppBridge>}={}): AppController {
  const state:AppState={persistence:'loading',settingsLoadFailed:false,settings:{...defaults},snapshot:{messages:[],spaces:[]},connected:false,glasses:false,displaySleeping:false,busy:false,
    recording:false,transcript:'',error:'',notice:'',readIds:[],hiddenIds:[],selectedSpaceIds:[]};
  const listeners=new Set<()=>void>();
  let relay:Relay|undefined,poll:ReturnType<typeof setTimeout>,saveTimer:ReturnType<typeof setTimeout>;
  let active=true,disposed=false,screen:'home'|'message'|'spaces'|'space-list'|'space'|'space-control'='home',page=0,spaceId='',spaceItem=0,spaceListPage=0,spaceItemId='';
  const spaceLayouts=new Map<string,'list'|'cards'>();
  type ControlTarget={spaceId:string;itemId:string;title:string;control:SpaceControl};
  let spaceEditor:{target:ControlTarget;value?:number|string}|undefined,recordingSpace:ControlTarget|undefined;
  let readJob:Promise<void>|undefined,contextualOpen=false,pendingMenuAction:(()=>Promise<void>)|undefined;
  let feedback:{kind:'busy'|'done'|'error';body:string;retry?:()=>Promise<void>;back?:()=>Promise<void>;waitForReply?:boolean;page?:number}|undefined;
  let actionSerial=0,renderSerial=0,voiceStatus='',recordingMode:'hold'|'toggle'|'head'='toggle';
  let capture:Uint8Array[]=[],captureBytes=0,voiceBusy=false,voiceSending=false,recordingTimeout:ReturnType<typeof setTimeout>;
  let selectedAudioBytes=0,classifiedAudioBytes=0;
  let pendingStop:'send'|'cancel'|undefined;
  let voiceFailure:unknown;
  let soniox:SonioxStream|RelayVoiceSession|undefined,liveUpdate:ReturnType<typeof setTimeout>|undefined;
  let foregroundAbort=new AbortController();
  const localSent:Message[]=[];
  const replyPoll=new ReplyPoll();
  // Session-only: restored history can never arm an automatic reply wake.
  const awaitingReplies=new Map<string,Set<string>>();
  let autoHiddenReplies=new Set<string>();
  let drawingChatFrame: number | undefined;
  let lastChatPage: {frame: number; key: string; inlineImage?: string; ready: Promise<void>} | undefined;
  let menuActions:Array<()=>Promise<void>>=[];
  let displayTimer:ReturnType<typeof setTimeout>|undefined,displayDeadline=0,followingChatId:string|undefined;
  let homeClockTimer:ReturnType<typeof setTimeout>|undefined;
  let avatarJob:Promise<void>|undefined,avatarFailedKey='',avatarRetryKey='',avatarRetryAfter=0;
  const glasses=new Glasses(handleEvent,options.bridgeFactory);
  const raise = new HeadRaise();
  let imuRequested = false;
  let calibration: {sample: (pitch: number) => void; cancel: () => void} | undefined;

  async function syncImu() {
    const wanted = glasses.ready && !disposed && (state.settings.headWake || !!calibration);
    if (wanted === imuRequested) return;
    imuRequested = wanted;
    raise.reset();
    try {
      if (!await glasses.run(b => b.imuControl(wanted, ImuReportPace.P100))) throw new Error('IMU');
    } catch (err) {
      if (wanted === imuRequested) imuRequested = false;
      if (wanted && !disposed) throw err;
    }
  }
  function measureNeutralPitch(): Promise<number> {
    if (!glasses.ready || disposed || calibration) return Promise.reject(new Error('IMU'));
    raise.reset();
    return new Promise((resolve, reject) => {
      const samples: number[] = [];
      let last = 0;
      function finish(value?: number) {
        clearTimeout(timer);
        calibration = undefined;
        raise.reset();
        fire(syncImu());
        if (value === undefined) reject(new Error('IMU'));
        else resolve(value);
      }
      const timer = setTimeout(() => finish(), 6000);
      const session = {cancel: () => finish(), sample(pitch: number) {
        const now = Date.now();
        if (now - last > 500 || samples.some(p => Math.abs(p - pitch) > 2)) samples.length = 0;
        last = now;
        samples.push(pitch);
        if (samples.length >= 6) finish(samples.reduce((sum, p) => sum + p, 0) / samples.length);
      }};
      calibration = session;
      void syncImu().catch(() => { if (calibration === session) session.cancel(); });
    });
  }
  let nativeHost=false;
  const nativeStorage={load:()=>glasses.load(),save:(value:string)=>glasses.save(value)};
  const storage=new StateStorage({
    getItem:key=>localStorage.getItem(key)||(key===LOCAL_STATE_KEY?sessionStorage.getItem('muse-relay-preview'):null),
    setItem:(key,value)=>{localStorage.setItem(key,value);try{sessionStorage.removeItem('muse-relay-preview');}catch{/* Optional legacy cleanup. */}},
  });
  let persistenceReady=false,savingSettings=false,saveAfterSettings=false,settingsGeneration=0;
  const text=(ja:string,en:string)=>translate(state.settings.language,ja,en);
  const emit=()=>{syncDisplayTimers();for(const fn of listeners)fn();};
  const error=(e:unknown)=>{
    const code=e instanceof Error?e.message:'Error';
    const imageMessage=imageFailure(code);
    if(imageMessage){state.error=imageMessage;emit();return;}
    const safe=/^(HTTP \d{3}|Soniox \d{3}|G2 timeout|Even app required|Microphone unavailable|Gist ID \/ URL|HTTPS URL|GitHub token|Relay token|Soniox temporary key|Soniox API key|Relay file missing|Relay messages missing|Attachment too large)$/.test(code)?code:'';
    state.error=text('処理できませんでした。接続と設定を確認してください。','Unable to complete. Check the connection and settings.')+(safe?` (${safe})`:'');emit();
  };
  const guarded=async<T>(fn:()=>Promise<T>):Promise<T>=>{state.error='';try{return await fn();}catch(e){error(e);throw e;}};
  const fire=(promise:Promise<unknown>)=>{void promise.catch(error);};
  const homeClockVisible=()=>!disposed&&active&&state.glasses&&state.persistence!=='loading'&&screen==='home'
    &&!state.displaySleeping&&!state.recording&&!voiceBusy&&!state.busy&&!contextualOpen&&!feedback;
  // Clock redraws must preserve native list selection and the user's hide deadline.
  function syncDisplayTimers(interaction=false){
    clearTimeout(homeClockTimer);
    if(homeClockVisible())homeClockTimer=setTimeout(()=>{if(homeClockVisible())fire(render());},60000-Date.now()%60000);
    clearTimeout(displayTimer);
    if(disposed||!active||!state.glasses||state.persistence==='loading'||!state.settings.autoHideSeconds
      ||state.displaySleeping||state.recording||voiceBusy||state.busy||drawingChatFrame===renderSerial||contextualOpen||feedback?.kind==='busy'){
      displayDeadline=0;return;
    }
    if(interaction||!displayDeadline)displayDeadline=Date.now()+state.settings.autoHideSeconds*1000;
    displayTimer=setTimeout(()=>fire(hideDisplay()),Math.max(0,displayDeadline-Date.now()));
  }
  function displayInteraction(){
    const sleeping=state.displaySleeping;
    autoHiddenReplies.clear();
    state.displaySleeping=false;
    if(sleeping){++renderSerial;glasses.invalidateRender();}
    syncDisplayTimers(true);
    if(sleeping)emit();
  }
  async function hideDisplay(){
    if(!displayDeadline||Date.now()<displayDeadline)return;
    autoHiddenReplies=new Set(awaitingReplies.keys());
    state.displaySleeping=true;displayDeadline=0;++renderSerial;glasses.invalidateRender();emit();
    try{await render();}
    catch(e){autoHiddenReplies.clear();state.displaySleeping=false;syncDisplayTimers(true);emit();throw e;}
  }
  function takeReplies(messages:Message[],previous:Message[]=[]):Message[]{
    const replies=messages.filter(message=>{
      if(!message.reply_to||!awaitingReplies.has(message.reply_to)
        ||awaitingReplies.get(message.reply_to)!.has(message.id)||!displayableMuseReply(message,state.settings.images))return false;
      // Compare only an unanswered request's visible candidate, without serializing images.
      // Turning images on must not make an unchanged, previously received row a new answer.
      const before=previous.find(item=>item.id===message.id);
      return !before||message.from!==before.from||message.type!==before.type||message.reply_to!==before.reply_to
        ||message.text!==before.text||(message.image_file||message.image?.data_base64)!==(before.image_file||before.image?.data_base64);
    });
    // Consume even an already-read/hidden reply or one received during recording.
    // Later polls and streaming updates must not turn it into a delayed wake.
    for(const reply of replies)awaitingReplies.delete(reply.reply_to!);
    return replies.filter(reply=>!state.readIds.includes(reply.id)&&!state.hiddenIds.includes(reply.id)
      &&!state.hiddenIds.includes(reply.reply_to!));
  }
  async function wakeForReply(reply:Message){
    displayInteraction();
    await act(()=>openMessage(reply.id,false));
  }
  async function restoreDisplay(){
    if(!active||disposed)return;
    const messageId=screen==='message'?state.selectedMessageId:undefined;
    displayInteraction();await render();
    if(!state.displaySleeping&&!contextualOpen&&screen==='message'&&messageId===state.selectedMessageId
      &&messageId&&!state.readIds.includes(messageId)){
      state.readIds.push(messageId);saveSoon();
    }
    emit();
  }
  function contextualMenu():GlassMenuItem[]{
    const item=(itemID:number,ja:string,en:string)=>({itemID,itemName:text(ja,en)});
    if(state.displaySleeping)return [item(10,'表示を戻す','Restore display')];
    if(state.recording)return [item(4,'録音を送信','Send recording'),item(7,'録音を中止','Cancel recording')];
    if(voiceBusy)return voiceSending?[]:[item(7,'録音を中止','Cancel recording')];
    if(feedback)return [item(3,'ホームへ戻る','Go home')];
    if(screen==='home')return [item(1,'更新','Refresh')];
    return [
      ...(['space','space-list','space-control'].includes(screen)?[
        item(9,'項目一覧','Space items'),
        item(8,spaceLayout()==='list'?'カード表示':'リスト表示',spaceLayout()==='list'?'Card view':'List view'),
      ]:[]),
      ...(screen!=='message'?[item(6,'チャットを開く','Open chat')]:[]),
      ...(screen!=='spaces'?[item(5,'スペースを選ぶ','Choose space')]:[]),
      item(4,'録音を開始','Record voice'),item(1,'更新','Refresh'),
      ...(screen==='message'?[item(11,state.settings.chatLayout==='exchange'?'1件ずつ':'入力と回答',state.settings.chatLayout==='exchange'?'One message at a time':'Input & reply')]:[]),
      ...(screen==='message'&&state.selectedMessageId?[item(2,'このメッセージを隠す','Hide message')]:[]),
    ];
  }
  const spaceLayout=(space=state.snapshot.spaces.find(s=>s.id===spaceId))=>spaceLayouts.get(space?.id||'')||space?.layout||'list';
  const currentSpaceItem=()=>state.snapshot.spaces.find(s=>s.id===spaceId)?.items.find(i=>i.id===spaceItemId);
  function controlTarget(id:string,itemId:string):ControlTarget{
    const item=state.snapshot.spaces.find(s=>s.id===id)?.items.find(i=>i.id===itemId);
    if(!item?.control||item.control.disabled)throw new Error('Space control unavailable');
    return {spaceId:id,itemId,title:item.title,control:structuredClone(item.control)};
  }
  function controlValue(control:SpaceControl):string{
    if(control.type==='slider')return `${control.value}${control.unit?' '+control.unit:''}`;
    if(control.type==='choice')return control.options.find(o=>o.id===control.value)?.title||text('選択','Choose');
    if(control.type==='microphone')return text('音声','Voice');
    if(control.type==='unsupported')return text('未対応','Unsupported');
    return control.label||text('実行','Run');
  }
  function spaceRow(item:SpaceItem):string{
    const value=item.control?controlValue(item.control):item.text.replace(/\s+/g,' ');
    return `${item.control?.disabled?'– ':''}${item.title}${value?' · '+value:''}`;
  }
  const nextBack=()=>text('タップ: 次へ · 2回: 戻る','Tap: next · Double-tap: back');
  function feedbackPages():GlassPage[]{
    const last=feedback?.kind==='busy'?text('ダブルタップ: 戻る','Double-tap: back')
      :feedback?.retry?text('タップ: 再試行 · 2回: 戻る','Tap: retry · Double-tap: back'):text('タップ: 戻る','Tap: back');
    return bodyPages(feedback?.body||'',(index,total)=>`${total>1?`${index+1}/${total} · `:''}${index<total-1?nextBack():last}`);
  }
  function editorPages():GlassPage[]{
    const {target,value}=spaceEditor!,control=target.control;
    let body=`${target.title}\n\n${control.type==='button'?control.confirm||'':''}`;
    if(control.type==='slider'){
      const level=Number(value);
      body=`${target.title}\n\n${level}${control.unit?' '+control.unit:''}\n${sliderTrack(level,control.min,control.max)}\n${control.min} — ${control.max}\n${text('スワイプ: 値を調整','Swipe: adjust value')}`;
    }
    return bodyPages(body,(index,total)=>index===total-1
      ?control.type==='button'?text('タップ: 実行 · 2回: 中止','Tap: run · Double-tap: cancel'):text('タップ: 送信 · 2回: 中止','Tap: send · Double-tap: cancel')
      :`${index+1}/${total} · ${text('タップ: 次へ · 2回: 中止','Tap: next · Double-tap: cancel')}`);
  }
  function controlPages(item:SpaceItem):GlassPage[]{
    return bodyPages(`${item.title}\n${item.text}\n\n${controlValue(item.control!)}`,(index,total)=>{
      const hint=index<total-1?nextBack():item.control!.disabled
        ?text('利用できません · 2回: 戻る','Unavailable · Double-tap: back'):text('タップ: 選択 · 2回: 戻る','Tap: select · Double-tap: back');
      return `${total>1?`${index+1}/${total} · `:''}${hint}`;
    });
  }
  async function spaceBack(){
    spaceEditor=undefined;feedback=undefined;page=0;
    screen=spaceLayout()==='list'?'space-list':'space';await render();
  }
  async function showSpaceItems(){spaceLayouts.set(spaceId,'list');spaceEditor=undefined;feedback=undefined;screen='space-list';await render();}
  const show=(body:string,footer='',image?:Attachment,style?:GlassTextStyle)=>active&&!contextualOpen
    ?glasses.show(state,body,footer,image,contextualMenu(),style):Promise.resolve();
  function imageFailure(code:string):string|undefined{
    if(/^Image download(?: HTTP \d{3})?$/.test(code))return text('画像を取得できませんでした\n接続を確認して再試行してください','Unable to download the image\nCheck the connection and retry')+(code.includes('HTTP')?` (${code.slice(15)})`:'');
    const messages:Record<string,[string,string]>={
      'Unsupported image':['対応していない画像形式です','Unsupported image format'],
      'Image decode':['画像を読み込めませんでした\n画像データを確認してください','Unable to decode the image\nCheck the image data'],
      'Image decode timeout':['画像の読み込みが時間切れになりました','Image loading timed out'],
      'Image conversion':['G2用の画像を作成できませんでした','Unable to prepare the image for G2'],
      'G2 image imageException':['G2が画像を読み込めませんでした','G2 could not read the image'],
      'G2 image imageSizeInvalid':['G2が画像の寸法・形式を受け付けませんでした','G2 rejected the image dimensions or format'],
      'G2 image imageToGray4Failed':['G2で画像を変換できませんでした','G2 could not convert the image'],
      'G2 image sendFailed':['G2への画像転送に失敗しました\n接続を確認して再試行してください','Image transfer to G2 failed\nCheck the glasses connection and retry'],
    };
    const message=messages[code];
    return message?text(...message)+` (${code.replace(/^G2 image /,'')})`:undefined;
  }
  async function imageAttachment(file:string,mime:string):Promise<Attachment>{
    if(!relay)throw new Error('Image download');
    try{return await relay.attachment(file,mime,foregroundAbort.signal);}
    catch(e){const code=e instanceof Error?e.message:'';throw new Error('Image download'+(/^HTTP \d{3}$/.test(code)?` ${code}`:''));}
  }
  const avatarKey=(profile: MuseProfile|undefined=state.snapshot.profile)=>profile?.avatar_file
    ?JSON.stringify([profile.avatar_file,profile.mime_type,profile.updated_at]):profile?.avatar?.data_base64||'';
  function syncProfileAvatar(){
    const profile=state.snapshot.profile,key=avatarKey(profile);
    if(!state.settings.images||!profile||!key){state.avatarStatus='none';return;}
    if(key===avatarFailedKey){state.avatarStatus='error';return;}
    if(profile.avatar){state.avatarStatus='ready';return;}
    if(key===avatarRetryKey&&Date.now()<avatarRetryAfter){state.avatarStatus='error';return;}
    if(!relay||disposed||!active)return;
    state.avatarStatus='loading';
    if(avatarJob)return;
    const current=relay;
    avatarJob=(async()=>{
      try{
        const avatar=await imageAttachment(profile.avatar_file!,profile.mime_type||'image/png');
        if(current!==relay||disposed||avatarKey()!==key||!state.settings.images)return;
        if(!avatar.mime.startsWith('image/')||avatar.data_base64.length>333336)throw new Error('Invalid avatar');
        state.snapshot.profile!.avatar=avatar;state.avatarStatus='ready';
        if(homeClockVisible())await render();
      }catch(e){
        if(current===relay&&avatarKey()===key){
          if(e instanceof Error&&e.message.startsWith('Image download')){avatarRetryKey=key;avatarRetryAfter=Date.now()+30000;}
          else avatarFailedKey=key;
          state.avatarStatus='error';
        }
      }finally{avatarJob=undefined;syncProfileAvatar();emit();}
    })();
  }
  function failureText(e:unknown):string{
    const code=e instanceof Error?e.message:'';
    const imageMessage=imageFailure(code);if(imageMessage)return imageMessage;
    if(code==='Relay token')return text('接続設定が必要です\nスマートフォンで設定してください','Connection setup needed\nSet up the relay on your phone');
    if(code.startsWith('G2'))return text('グラス表示を更新できませんでした\nスマートフォンで接続を確認','Display update failed\nCheck the glasses connection on your phone');
    if(code==='Microphone unavailable')return text('マイクを開始できませんでした\nスマートフォンで音声設定を確認','Microphone unavailable\nCheck voice settings on your phone');
    if(code==='Busy')return text('送信処理中です\n完了後にもう一度操作してください','Sending in progress\nTry again when it finishes');
    if(code==='Space control unavailable'||code==='Space control changed')return text('この操作は更新されています\n一覧に戻って選び直してください','This control has changed\nReturn to the list and choose again');
    return text('処理に失敗しました\n接続と設定を確認してください','Action failed\nCheck the connection and settings');
  }
  function failureFeedback(e:unknown,retry?:()=>Promise<void>):NonNullable<typeof feedback>{
    return {kind:'error',body:failureText(e),retry,
      ...(/^Space control/.test(e instanceof Error?e.message:'')?{back:spaceBack}
        :imageFailure(e instanceof Error?e.message:'')?{back:screen==='space'?showSpaces:showMenu}:{})};
  }
  async function act(action:()=>Promise<void>,pending?:string,done?:()=>string,retry=true){
    if(disposed||!active)return;
    const id=++actionSerial;
    feedback=pending?{kind:'busy',body:pending}:undefined;
    state.error='';emit();
    try{
      if(pending)await render();
      await action();
      if(id===actionSerial&&done){feedback={kind:'done',body:done()};await render();}
    }catch(e){
      error(e);
      if(id!==actionSerial||!active||disposed)return;
      feedback=failureFeedback(e,retry?()=>act(action,pending,done,retry):undefined);
      await render().catch(error);
    }
  }
  const refreshFromGlasses=()=>act(()=>refresh(true),text('更新中…','Refreshing…'),()=>text('更新しました','Updated'));
  const visible=()=>state.snapshot.messages.filter(m=>!state.hiddenIds.includes(m.id)).sort((a,b)=>b.ts-a.ts);
  const serializable=():SavedState=>({settings:state.settings,snapshot:{messages:state.snapshot.messages.slice(-50).map(({image,...m})=>m),
    spaces:state.snapshot.spaces.map(s=>({...s,items:s.items.map(({image,...i})=>i)})),
    ...(state.snapshot.profile?{profile:{...state.snapshot.profile,avatar:undefined}}:{})},
    readIds:state.readIds.slice(-300),hiddenIds:state.hiddenIds.slice(-300),selectedSpaceIds:state.selectedSpaceIds});
  async function save(explicit=false){
    clearTimeout(saveTimer);
    if(savingSettings){saveAfterSettings=saveAfterSettings||explicit;return;}
    if(!persistenceReady||state.persistence==='loading')return;
    const mode=await storage.save(serializable(),explicit);
    if(mode&&state.persistence!==mode){state.persistence=mode;emit();}
    try{localStorage.setItem('muse-relay-theme',state.settings.theme);}catch{/* Cosmetic preference only. */}
  }
  function saveSoon(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>fire(save()),500);}
  async function loadSettings(){
    const generation=++settingsGeneration;
    replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();
    state.persistence='loading';state.settingsLoadFailed=false;clearTimeout(poll);clearTimeout(saveTimer);emit();
    const result=await storage.load();
    if(generation!==settingsGeneration||result.stale)return;
    if(result.value){
      const saved=result.value;state.settings=saved.settings;state.snapshot=saved.snapshot;
      state.readIds=saved.readIds;state.hiddenIds=saved.hiddenIds;state.selectedSpaceIds=saved.selectedSpaceIds;
      relay=state.settings.configured?makeRelay(state.settings):undefined;state.connected=false;
    }
    persistenceReady=result.writable;state.persistence=result.mode;state.settingsLoadFailed=result.failed;
    raise.reset();fire(syncImu());
    document.documentElement.dataset.evenTheme=state.settings.theme;syncProfileAvatar();emit();armPoll(0);
  }
  const savedNotice=(mode:AppState['persistence'])=>mode==='native'
    ?text('Evenアプリに設定を保存しました。','Settings saved in the Even app.')
    :nativeHost?text('端末のバックアップに保存しました。Even側への保存は未確認です。','Saved to the device backup. Saving in Even is not confirmed.')
      :text('このブラウザーに設定を保存しました。','Settings saved in this browser.');
  async function persistSettings(settings:Settings,clear=false){
    if(state.recording||voiceBusy||savingSettings||state.busy)throw new Error('Busy');
    if(!clear&&!persistenceReady&&!settings.configured)throw new Error('Settings read failed');
    const checked=validateSettings(settings,settings.configured);
    const connectionChanged=clear||(['configured','relay','gistId','githubToken','relayUrl','relayToken','gatewayToken'] as const)
      .some(key=>checked[key]!==state.settings[key]);
    ++settingsGeneration;savingSettings=true;state.busy=true;clearTimeout(saveTimer);emit();
    const saved=clear?{settings:checked,snapshot:{messages:[],spaces:[]},readIds:[],hiddenIds:[],selectedSpaceIds:[]}: {...serializable(),settings:checked};
    try{
      const mode=await storage.save(saved,true);
      state.settings=checked;
      if(!checked.autoHideSeconds){state.displaySleeping=false;autoHiddenReplies.clear();}
      if(!checked.returnToChatAfterSend)followingChatId=undefined;
      displayDeadline=0;
      if(clear){state.snapshot=saved.snapshot;state.readIds=saved.readIds;state.hiddenIds=saved.hiddenIds;state.selectedSpaceIds=saved.selectedSpaceIds;}
      if(connectionChanged){replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();foregroundAbort.abort();foregroundAbort=new AbortController();relay=checked.configured?makeRelay(checked):undefined;state.connected=false;delete state.snapshot.profile;delete state.snapshot.capabilities;avatarFailedKey='';}
      persistenceReady=true;state.persistence=mode||'unavailable';state.settingsLoadFailed=false;state.error='';
      state.notice=clear?(mode==='native'?text('接続情報を削除しました。','Connection details removed.')
        :nativeHost?text('端末の接続情報を削除しました。Even側の削除は未確認です。','Device connection details removed. Removal in Even is not confirmed.')
          :text('このブラウザーの接続情報を削除しました。','Connection details removed from this browser.')):savedNotice(state.persistence);
      if(clear){localSent.length=0;screen='home';state.selectedMessageId=undefined;feedback=undefined;}
      raise.reset();fire(syncImu());
      document.documentElement.dataset.evenTheme=checked.theme;
      try{localStorage.setItem('muse-relay-theme',checked.theme);}catch{/* Cosmetic preference only. */}
      emit();if(connectionChanged)armPoll(0);else armPoll();
    }catch(e){if(state.persistence==='loading')state.persistence='unavailable';throw e;}
    finally{
      savingSettings=false;state.busy=false;syncProfileAvatar();emit();
      if(saveAfterSettings){saveAfterSettings=false;await save(true);}else saveSoon();
    }
    fire(render());
  }
  function detectNativeHost(){
    if(!nativeHost&&'flutter_inappwebview' in window){nativeHost=true;storage.useNative(nativeStorage);}
    return nativeHost;
  }
  async function waitForHost(){
    if(detectNativeHost())return;
    // Give the host time to inject its bridge; actual readiness still uses the SDK helper.
    await new Promise<void>(resolve=>{
      const finish=()=>{clearInterval(probe);clearTimeout(timeout);resolve();};
      const probe=setInterval(()=>{if(detectNativeHost())finish();},50);
      const timeout=setTimeout(finish,1500);
    });
  }
  function makeRelay(settings:Settings):Relay{return settings.relay==='gist'?new GistRelay(settings):new GadgetRelay(settings);}
  function armPoll(delay=replyPoll.delay(state.settings.pollSeconds*1000)){clearTimeout(poll);if(active&&relay&&!disposed)poll=setTimeout(()=>fire(refresh()),delay);}
  function chatPage(): ChatPage {
    const messages=visible(),selected=messages.find(m=>m.id===state.selectedMessageId);
    if(!selected)return {body:text('メッセージはありません\n録音またはスマートフォンから送信','No messages yet\nRecord voice or send from your phone'),footer:text('ダブルタップ: ホーム','Double-tap: home')};
    const exchange=state.settings.chatLayout==='exchange'?chatExchange(messages,selected.id,{legacy:state.settings.relay==='gist'}):undefined;
    const message=exchange?.reply||selected,waiting=Boolean(exchange&&!exchange.reply);
    const messageText=(m:Message)=>chatText(m)||(m.type==='image'?text('画像','Image'):text('音声メッセージ','Voice message'));
    const stamp=(m:Message)=>new Date(m.ts*1000).toLocaleString(resolveLocale(state.settings.language),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    let input:string|undefined;
    if(exchange){
      const original=messages.find(m=>m.id===exchange.input.reply_to&&m.from==='You')??exchange.input;
      input=excerpt(translate(state.settings.language,'あなた: {text}','You: {text}',{text:`${stamp(original)} · ${messageText(exchange.input)}`}),2);
    }
    const body=waiting?text('Muse の応答を待っています','Waiting for Muse'):exchange?`${message.from}: ${messageText(message)}`:`${message.from} · ${stamp(message)}\n${messageText(message)}`;
    const hasImage=!waiting&&state.settings.images&&Boolean(message.image||message.image_file);
    const pages=bodyPages(body,(index,total)=>`${index+1}/${total} · ${index<total-1
      ?text('タップ: 次のページ · 2回: ホーム','Tap: next page · Double-tap: home'):text('2回タップ: ホーム','Double-tap: home')}`,input,hasImage);
    if(page>=pages.length)page=0;
    const current=pages[page]!;
    return {body:current.body,footer:current.footer,messageId:message.id,readReplyId:exchange?.reply?.id,
      photo:current.image?message:undefined,style:current.image?undefined:{input,bodyColor:!waiting&&message.from==='You'?1:4}};
  }

  async function render(forceChat=false){
    const visibleChat=glasses.ready&&active&&!disposed&&!contextualOpen&&!state.displaySleeping&&screen==='message';
    const view=visibleChat&&!state.recording&&!voiceBusy&&!feedback?chatPage():undefined;
    let key='',inlineImage:string|undefined;
    if(view){
      const {photo,...content}=view;
      // A downloaded file keeps its identity when a poll replaces the snapshot.
      // Compare inline bytes separately to avoid serializing an entire image on each poll.
      const file=photo?.image_file;
      inlineImage=photo?.image?.data_base64;
      key=JSON.stringify([state.selectedMessageId,page,state.settings.language,contextualMenu(),content,
        file,file?photo.ts:undefined,file?photo.mime_type:photo?.image?.mime]);
      if(lastChatPage?.frame===renderSerial&&lastChatPage.key===key&&lastChatPage.inlineImage===inlineImage
        &&(!forceChat||drawingChatFrame===renderSerial))return lastChatPage.ready;
      if(forceChat)glasses.invalidateImage();
    }
    if(drawingChatFrame!==undefined)glasses.invalidateRender();
    const frame=++renderSerial;
    lastChatPage=undefined;
    drawingChatFrame=visibleChat?frame:undefined;
    if(visibleChat)syncDisplayTimers();
    const ready=drawFrame(frame,view);
    if(view)lastChatPage={frame,key,inlineImage,ready};
    return ready;
  }

  async function drawFrame(frame:number,view?:ChatPage){
    try{
      if(view)await drawChatPage(frame,view);
      else await renderContent(frame);
    }catch(e){
      if(view&&frame!==renderSerial)return;
      if(lastChatPage?.frame===frame)lastChatPage=undefined;
      const message=imageFailure(e instanceof Error?e.message:'');
      if(message&&frame===renderSerial&&active&&!contextualOpen&&!feedback){
        feedback=failureFeedback(e,()=>act(render));
        await render().catch(error);
      }
      throw e;
    }finally{
      // Only the current page can start its reading interval. A superseded transfer
      // may finish after the reader has already moved to another page.
      if(drawingChatFrame===frame)drawingChatFrame=undefined;
      syncDisplayTimers();
    }
  }

  async function drawChatPage(frame:number,view:ChatPage){
    const photo=view.photo;
    let image=photo?.image;
    if(photo?.image_file&&!image&&relay){
      await show(text('画像を読み込み中…','Loading image…'),text('ダブルタップ: 戻る','Double-tap: back'));
      if(frame!==renderSerial)return;
      const source=relay;
      image=await imageAttachment(photo.image_file,photo.mime_type||'image/png');
      const current=source===relay&&state.snapshot.messages.find(m=>m.id===photo.id&&m.ts===photo.ts&&m.image_file===photo.image_file&&m.mime_type===photo.mime_type);
      if(current&&!current.image)current.image=image;
      if(frame!==renderSerial)return;
      // A subsequent snapshot may contain these same bytes or a replacement for the same file.
      if(lastChatPage?.frame===frame)lastChatPage.inlineImage=image.data_base64;
    }
    await show(view.body,view.footer,image,view.style);
    if(frame===renderSerial&&!state.displaySleeping&&!contextualOpen&&view.readReplyId&&!state.readIds.includes(view.readReplyId)){
      state.readIds.push(view.readReplyId);emit();saveSoon();
    }
  }

  async function renderContent(frame:number){
    if(!glasses.ready||!active||disposed||contextualOpen)return;
    // Keep an event-capturing page alive, with no text, footer, list border or image.
    if(state.displaySleeping){await show(' ',' ');return;}
    if(state.recording){
      const footer=recordingMode==='hold'?text('離す: 送信 · 2回タップ: 中止','Release: send · Double-tap: cancel')
        :recordingMode==='head' && soniox ? text('発話終了で送信 · 2回タップ: 中止','Auto-send after speech · Double-tap: cancel')
        :text('タップ: 送信 · 2回タップ: 中止','Tap: send · Double-tap: cancel');
      const rows=glassBodyRows(footer),body=(recordingSpace?recordingSpace.title+'\n':'')+(state.transcript||text('録音中…','Recording…'));
      // Keep one stable body region throughout capture and show its newest complete lines.
      const tail=paginate(wrapLines(body).slice(-rows).join('\n'),rows).at(-1)!;
      await show(tail,footer,undefined,{bodyColor:state.transcript&&!recordingSpace?1:4});return;
    }
    if(voiceBusy){await show(voiceStatus,voiceSending?text('送信完了を待っています','Waiting for delivery'):text('ダブルタップ: 中止','Double-tap: cancel'));return;}
    if(feedback){
      const pages=feedbackPages();feedback.page=Math.min(feedback.page||0,pages.length-1);
      await show(pages[feedback.page]!.body,pages[feedback.page]!.footer);return;
    }
    if(screen==='home'){
      menuActions=[showChat,showSpaces,()=>api.toggleRecording()];
      const dateTime=new Date().toLocaleString(resolveLocale(state.settings.language),{
        year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
      });
      const items=[text('チャット','Chat'),text('スペース','Spaces'),text('録音を開始','Record voice')];
      const footer=text('タップ: 開く · 2回: 終了','Tap: open · Double-tap: exit');
      const avatar=state.settings.images&&state.avatarStatus!=='error'?state.snapshot.profile?.avatar:undefined;
      try{await glasses.list(state,items,footer,contextualMenu(),dateTime,avatar);}
      catch(e){
        if(!avatar)throw e;
        if(frame!==renderSerial)return;
        avatarFailedKey=avatarKey();state.avatarStatus='error';
        await glasses.list(state,items,footer,contextualMenu(),dateTime);emit();
      }
      return;
    }
    if(screen==='spaces'){
      const spaces=state.selectedSpaceIds.map(id=>state.snapshot.spaces.find(s=>s.id===id)).filter(s=>s!==undefined).slice(0,15);
      menuActions=spaces.map(space=>()=>api.showSpace(space.id));
      if(!spaces.length){
        await show(text('スペースが選択されていません\nスマートフォンでスペースを選択','No spaces selected\nChoose spaces on your phone'),text('ダブルタップ: ホーム','Double-tap: home'));return;
      }
      await glasses.list(state,spaces.map(space=>space.title),text('タップ: 開く · 2回: ホーム','Tap: open · Double-tap: home'),contextualMenu());return;
    }
    if(screen==='space-list'){
      const space=state.snapshot.spaces.find(s=>s.id===spaceId);
      if(!space){await showSpaces();return;}
      const total=Math.max(1,Math.ceil(space.items.length/18));spaceListPage=Math.min(spaceListPage,total-1);
      const entries=space.items.slice(spaceListPage*18,(spaceListPage+1)*18);
      const labels=entries.map(spaceRow);menuActions=entries.map(item=>()=>activateSpaceItem(space.id,item.id));
      if(spaceListPage>0){labels.push(text('前の項目','Previous items'));menuActions.push(async()=>{spaceListPage--;await render();});}
      if(spaceListPage+1<total){labels.push(text('次の項目','Next items'));menuActions.push(async()=>{spaceListPage++;await render();});}
      if(!labels.length){await show(`${space.title}\n${text('項目はありません','No items yet')}`,text('ダブルタップ: スペース一覧','Double-tap: spaces'));return;}
      await glasses.list(state,labels,`${spaceListPage+1}/${total} · ${text('タップ: 選択 · 2回: 戻る','Tap: select · Double-tap: back')}`,contextualMenu());return;
    }
    if(screen==='space-control'&&spaceEditor){
      const {target,value}=spaceEditor,control=target.control;
      if(control.type==='choice'){
        menuActions=control.options.map(option=>()=>dispatchSpaceAction(spaceRequest(target,option.id)));
        await glasses.list(state,control.options.map(option=>`${option.id===value?'✓ ':''}${option.title}`),text('タップ: 送信 · 2回: 中止','Tap: send · Double-tap: cancel'),contextualMenu());return;
      }
      if(control.type==='slider'||control.type==='button'){
        const pages=editorPages();page=Math.min(page,pages.length-1);
        await show(pages[page]!.body,pages[page]!.footer);return;
      }
    }
    if(screen==='space'){
      const space=state.snapshot.spaces.find(s=>s.id===spaceId),item=space?.items[spaceItem];
      if(!space){await showSpaces();return;}
      if(!item){await show(`${space.title}\n${text('項目はありません','No items yet')}`,text('ダブルタップ: スペース一覧','Double-tap: spaces'));return;}
      spaceItemId=item.id;
      if(item.control){
        const pages=controlPages(item);page=Math.min(page,pages.length-1);
        await show(pages[page]!.body,pages[page]!.footer);return;
      }
      const hasImage=state.settings.images&&Boolean(item.image||item.image_file);
      const pages=bodyPages(`${space.title} / ${item.title}\n${item.text}`,(index,total)=>
        `${spaceItem+1}/${space.items.length} · ${index+1}/${total} · ${index<total-1?nextBack():text('ダブルタップ: 戻る','Double-tap: back')}`,undefined,hasImage);
      if(page>=pages.length)page=0;
      const current=pages[page]!;
      let image=current.image?item.image:undefined;
      if(current.image&&!image&&item.image_file&&relay){
        await show(text('画像を読み込み中…','Loading image…'),text('ダブルタップ: 戻る','Double-tap: back'));
        image=await imageAttachment(item.image_file,'image/png');item.image=image;
      }
      if(frame!==renderSerial)return;
      await show(current.body,current.footer,image);return;
    }
  }
  async function showMenu(){
    if(state.recording||voiceBusy)return;
    displayInteraction();followingChatId=undefined;
    screen='home';page=0;feedback=undefined;await render();
  }
  async function showChat(){
    if(state.recording||voiceBusy)return;
    displayInteraction();followingChatId=undefined;
    const first=visible()[0];
    if(first){await api.showMessage(first.id);return;}
    screen='message';state.selectedMessageId=undefined;page=0;feedback=undefined;await render();
  }
  async function showSpaces(){
    if(state.recording||voiceBusy)return;
    displayInteraction();followingChatId=undefined;
    screen='spaces';page=0;feedback=undefined;await render();
  }
  async function refresh(explicit=false){
    if(!active)return;
    if(explicit){avatarFailedKey='';avatarRetryAfter=0;}
    if(!relay){if(explicit)throw new Error('Relay token');return;}
    // A manual refresh joins the existing read instead of silently doing nothing.
    if(!readJob)readJob=readSnapshot().finally(()=>{readJob=undefined;});
    if(explicit)await readJob;else await readJob.catch(()=>{});
  }
  async function readSnapshot(){
    const current=relay!,signal=foregroundAbort.signal;
    try{const snap=await current.read(signal);if(current!==relay||!active||signal.aborted)return;
      const previousAvatarKey=avatarKey();
      if(snap.profile?.avatar_file&&!snap.profile.avatar&&avatarKey(snap.profile)===previousAvatarKey)
        snap.profile.avatar=state.snapshot.profile?.avatar;
      replyPoll.observe(snap.messages);
      const before=new Set(state.snapshot.messages.map(m=>m.id));
      const previousMessages=state.snapshot.messages;
      for(const sent of localSent)if(!snap.messages.some(m=>m.id===sent.id))snap.messages.push(sent);
      // Preserve downloaded attachments while their relay reference/version is unchanged.
      // Otherwise every poll flashes a loading page and needlessly retransmits the image.
      for(const message of snap.messages){
        const previous=state.snapshot.messages.find(m=>m.id===message.id);
        if(!message.image&&message.image_file&&previous?.image&&previous.image_file===message.image_file
          &&previous.ts===message.ts&&previous.mime_type===message.mime_type)message.image=previous.image;
      }
      for(const space of snap.spaces){
        const previousSpace=state.snapshot.spaces.find(s=>s.id===space.id);
        if(previousSpace?.updated_at!==space.updated_at)continue;
        for(const item of space.items){
          const previous=previousSpace?.items.find(i=>i.id===item.id);
          if(!item.image&&item.image_file&&previous?.image&&previous.image_file===item.image_file
            &&previous.ts===item.ts)item.image=previous.image;
        }
      }
      snap.messages.sort((a,b)=>a.ts-b.ts);state.snapshot=snap;syncProfileAvatar();state.connected=true;state.lastSync=Date.now();if(feedback?.kind!=='error')state.error='';
      const selectedSpace=snap.spaces.find(s=>s.id===spaceId);
      if(spaceItemId&&selectedSpace){const index=selectedSpace.items.findIndex(i=>i.id===spaceItemId);spaceItem=Math.max(0,index);}
      const arrivedReplies=takeReplies(snap.messages,previousMessages);
      const wakeReply=state.displaySleeping&&state.settings.autoHideSeconds&&!state.recording&&!voiceBusy
        &&!state.busy&&!contextualOpen&&(!feedback||feedback.waitForReply)
        ?arrivedReplies.filter(message=>autoHiddenReplies.has(message.reply_to!)).at(-1):undefined;
      const newMessages=snap.messages.filter(m=>!before.has(m.id)&&m.from!=='You');
      const sent=followingChatId?snap.messages.find(m=>m.id===followingChatId):undefined;
      const reply=followingChatId?newMessages.filter(m=>!state.hiddenIds.includes(m.id)
        &&(m.reply_to===followingChatId||(!m.reply_to&&sent&&m.ts>=sent.ts))).at(-1):undefined;
      if(wakeReply){
        await wakeForReply(wakeReply);
      }else if(reply&&screen==='message'&&!state.recording&&!voiceBusy&&!feedback){
        // Other receives stay behind the blank display until an explicit gesture.
        state.selectedMessageId=reply.id;page=0;
        if(!state.displaySleeping&&!contextualOpen)await act(()=>openMessage(reply.id,false));
      }else if(!state.displaySleeping&&newMessages.length&&!state.recording&&!voiceBusy&&!contextualOpen&&((screen==='home'&&!feedback)||feedback?.waitForReply)){
        await act(()=>openMessage(newMessages.at(-1)!.id,false));
      }else if(!state.displaySleeping&&['message','space','spaces','space-list','space-control'].includes(screen)&&!feedback){
        if(screen==='message'&&!visible().some(m=>m.id===state.selectedMessageId))state.selectedMessageId=visible()[0]?.id;
        // Relay success remains a relay success even if local image/G2 rendering fails.
        await act(render);
      }
      if(homeClockVisible()&&previousAvatarKey!==avatarKey())fire(render());
      emit();saveSoon();armPoll();
    }catch(e){if(!signal.aborted){replyPoll.clear();state.connected=false;error(e);armPoll(Math.max(30000,state.settings.pollSeconds*2000));throw e;}}
  }
  async function send(request:RelayRequest){
    if(!relay)throw new Error('Relay token');
    if(state.busy)throw new Error('Busy');
    if(request.image&&state.settings.relay==='gadget'&&state.snapshot.capabilities?.images!==true)throw new Error('Image sending unavailable');
    const current=relay,beforeIds=new Set(state.snapshot.messages.map(message=>message.id));
    state.busy=true;state.error='';emit();
    try{await relay.send(request,foregroundAbort.signal);
      const sent:Message={id:request.id,from:'You',type:request.audio?'voice-note':request.image?'image':'text',text:request.text,ts:request.created_at,...(request.image?{image:request.image}:{})};
      localSent.push(sent);if(localSent.length>50)localSent.shift();state.snapshot.messages.push(sent);
      if(request.kind==='chat'&&current===relay&&active&&!disposed){
        awaitingReplies.set(request.id,beforeIds);
        if(awaitingReplies.size>50)awaitingReplies.delete(awaitingReplies.keys().next().value!);
        takeReplies(state.snapshot.messages); // A response can arrive before the send acknowledgement.
      }
      if(state.settings.relay==='gadget'&&active&&!disposed){replyPoll.sent(request.id);replyPoll.observe(state.snapshot.messages);}
      state.notice=text('中継へ送信しました。Muse の応答を待っています。','Sent to relay. Waiting for Muse.');emit();saveSoon();
      if(state.settings.relay==='gadget')armPoll();else armPoll(2000);
    }finally{state.busy=false;emit();}
  }
  const request=(textValue:string):RelayRequest=>({id:`r_${crypto.randomUUID()}`,kind:'chat',text:textValue,created_at:Math.floor(Date.now()/1000)});
  async function openMessage(id:string,interaction=true){
    if(!state.snapshot.messages.some(m=>m.id===id))return;
    if(interaction){displayInteraction();followingChatId=undefined;}
    state.selectedMessageId=id;screen='message';page=0;feedback=undefined;state.error='';
    const ready=render(true),frame=renderSerial;
    await ready;
    if(glasses.ready&&active&&!disposed&&frame===renderSerial&&!state.displaySleeping&&!contextualOpen&&!state.recording&&!voiceBusy
      &&screen==='message'&&state.selectedMessageId===id&&!state.readIds.includes(id))state.readIds.push(id);
    emit();saveSoon();
  }
  async function returnToSentChat(id:string){
    if(!state.settings.returnToChatAfterSend||!active||disposed)return;
    displayInteraction();followingChatId=id;
    // A receive already in flight can deliver Muse's reply before the POST acknowledgement.
    const reply=visible().find(m=>m.from!=='You'&&m.reply_to===id);
    // A display failure must never turn an accepted send into a retryable send error.
    await openMessage(reply?.id||id,false).catch(error);
  }
  function spaceRequest(target:ControlTarget,value?:number|string,transcript=''):RelayRequest{
    const action={item_id:target.itemId,type:target.control.type,...(value!==undefined?{value}:{})};
    if(action.type==='unsupported')throw new Error('Space control unavailable');
    const req=request(transcript||`${target.title}${value!==undefined?`: ${value}`:''}`);
    req.kind='space';req.space_id=target.spaceId;req.space_action=action as NonNullable<RelayRequest['space_action']>;
    const current=controlTarget(target.spaceId,target.itemId);
    if(!matchesSpaceAction(current.control,req.space_action))throw new Error('Space control changed');
    return req;
  }
  async function dispatchSpaceAction(req:RelayRequest){
    if(state.busy)throw new Error('Busy');
    const action=req.space_action!;
    const status=(phase:NonNullable<AppState['spaceAction']>['status'],message:string)=>{
      state.spaceAction={spaceId:req.space_id!,itemId:action.item_id,status:phase,message};emit();
    };
    const serial=++actionSerial;
    feedback={kind:'busy',body:text('操作を送信中…','Sending action…')};status('sending',feedback.body);
    try{
      const target=controlTarget(req.space_id!,action.item_id);
      if(!matchesSpaceAction(target.control,action))throw new Error('Space control changed');
      // Sending and its result must not depend on the G2 display being available.
      void render().catch(()=>{});
      await send(req);
      status('sent',text('中継が受け付けました','Accepted by relay'));
      if(serial===actionSerial)feedback={kind:'done',body:text('中継が受け付けました\n結果はスペースの更新で確認','Accepted by relay\nResults appear in the updated space'),back:spaceBack};
    }catch(e){
      error(e);status('error',failureText(e));
      if(serial===actionSerial)feedback={kind:'error',body:failureText(e),retry:()=>dispatchSpaceAction(req),back:spaceBack};
    }
    void render().catch(()=>{});
  }
  async function activateSpaceItem(id:string,itemId:string){
    if(state.recording||voiceBusy||state.busy)return;
    const space=state.snapshot.spaces.find(s=>s.id===id),item=space?.items.find(i=>i.id===itemId);
    if(!space||!item)return;
    displayInteraction();followingChatId=undefined;
    spaceId=id;spaceItem=space.items.indexOf(item);spaceItemId=item.id;page=0;feedback=undefined;spaceEditor=undefined;
    if(!item.control){screen='space';await render();return;}
    if(item.control.disabled){
      feedback={kind:'error',body:text('この操作は利用できません','This control is unavailable'),back:spaceBack};await render();return;
    }
    const target=controlTarget(id,itemId),control=target.control;
    if(control.type==='microphone'){await startRecording('toggle',target);return;}
    if(control.type==='button'&&!control.confirm){await dispatchSpaceAction(spaceRequest(target));return;}
    screen='space-control';spaceEditor={target,value:control.type==='slider'||control.type==='choice'?control.value:undefined};await render();
  }
  function voiceFailed(failure: unknown) {
    if (!state.recording || pendingStop === 'cancel') return;
    voiceFailure = failure;
    fire(act(()=>stopRecording(false),undefined,undefined,false));
  }
  function ingest(audio:NonNullable<EvenHubEvent['audioEvent']>){
    if(!state.recording||pendingStop)return;
    const limit = 120 * 32000;
    const pcm = audio.audioPcm.subarray(0, limit - captureBytes);
    const filter=state.settings.mic==='glasses'?state.settings.speakerFilter:'all';
    const classified=audio.source!==AudioInputSource.Phone&&(audio.speakerRole===AudioSpeakerRole.Self||audio.speakerRole===AudioSpeakerRole.Other);
    const selected=filter==='all'||(classified&&audio.speakerRole===filter);
    if(classified)classifiedAudioBytes+=pcm.length;
    if(selected)selectedAudioBytes+=pcm.length;
    // Keep pauses and recording duration intact; only selected audio reaches either transcriber.
    const audioFrame=selected?pcm:new Uint8Array(pcm.length);captureBytes+=audioFrame.length;
    if(!soniox)capture.push(selected?pcm.slice():audioFrame);
    else try{soniox.push(audioFrame);}catch(e){voiceFailed(e);}
    if (captureBytes === limit) fire(act(() => stopRecording(false), undefined, undefined, false));
  }
  async function startRecording(mode:'hold'|'toggle'|'head'='toggle',target?:ControlTarget){
    if(state.recording||voiceBusy||state.busy)return;
    displayInteraction();
    if(!state.settings.configured)throw new Error('Relay token');
    if(!glasses.ready)throw new Error('Even app required');
    ++renderSerial;glasses.invalidateRender();
    recordingSpace=target;
    if(target)state.spaceAction={spaceId:target.spaceId,itemId:target.itemId,status:'recording',message:target.title};
    voiceBusy=true;recordingMode=mode;pendingStop=undefined;voiceFailure=undefined;state.busy=true;state.transcript='';capture=[];captureBytes=0;selectedAudioBytes=0;classifiedAudioBytes=0;
    feedback=undefined;voiceStatus=text('録音を準備中…','Preparing microphone…');emit();
    try{
      // Arm audio before sending any display updates or waiting for Soniox.
      state.recording=true;
      const opening=glasses.microphone(true,state.settings.mic==='phone');
      const relayLiveVoice=state.settings.voice==='muse'&&state.settings.relay==='gadget'&&state.snapshot.capabilities?.live_transcription===true;
      if(state.settings.voice==='soniox'||relayLiveVoice){
        const onText = (value: string) => {
          if(value===state.transcript)return;
          state.transcript=value;emit();
          if(state.recording&&!liveUpdate)liveUpdate=setTimeout(()=>{liveUpdate=undefined;fire(render());},400);
        };
        const onEndpoint = mode === 'head' ? () => {
          if (state.recording && !pendingStop) fire(act(() => stopRecording(false), undefined, undefined, false));
        } : undefined;
        soniox = relayLiveVoice ? new RelayVoiceSession(state.settings, onText, voiceFailed, onEndpoint)
          : new SonioxStream(onText, voiceFailed, onEndpoint);
        // SonioxStream reports failures through voiceFailed and queues audio until ready.
        void soniox.start(state.settings).catch(()=>{});
      }
      await opening;
      state.notice='';
      recordingTimeout=setTimeout(()=>fire(act(()=>stopRecording(false),undefined,undefined,false)),120000);
    }catch(e){
      state.recording=false;recordingSpace=undefined;if(target)state.spaceAction=undefined;
      soniox?.cancel();soniox=undefined;capture=[];clearTimeout(liveUpdate);liveUpdate=undefined;
      await glasses.microphone(false,state.settings.mic==='phone').catch(()=>{});throw e;
    }
    finally{
      voiceBusy=false;state.busy=false;const pending=pendingStop;pendingStop=undefined;emit();
      if(pending&&state.recording){
        // Cleanup must still close a microphone that finished opening after background/exit.
        fire(active&&!disposed?act(()=>stopRecording(pending==='cancel'),undefined,undefined,false):stopRecording(true));
      }
    }
    if(state.recording)await render().catch(error);
  }
  async function stopRecording(cancel:boolean){
    if(voiceBusy){
      // Cancellation wins over a release until the request has started sending.
      if(!voiceSending&&(cancel||pendingStop!=='cancel')){
        pendingStop=cancel?'cancel':'send';
        if(cancel)soniox?.cancel();
      }
      return;
    }
    if(!state.recording)return;
    voiceBusy=true;state.busy=true;pendingStop=cancel?'cancel':'send';state.recording=false;clearTimeout(recordingTimeout);clearTimeout(liveUpdate);liveUpdate=undefined;
    voiceStatus=cancel?text('録音を中止中…','Cancelling recording…'):text('音声を処理中…','Processing voice…');emit();
    const stream=soniox;
    if(cancel)stream?.cancel();
    const target=recordingSpace;
    let sentChatId:string|undefined;
    const voiceRequest=(transcript:string)=>target?spaceRequest(target,undefined,transcript):request(transcript);
    const cancelled=()=>pendingStop==='cancel';
    const cancelNotice=()=>{stream?.cancel();state.notice=text('録音を中止しました','Recording cancelled');feedback={kind:'done',body:state.notice};};
    try{
      const closing=glasses.microphone(false,state.settings.mic==='phone');
      void render().catch(error);
      await closing;
      if(cancelled()){cancelNotice();return;}
      if(voiceFailure)throw voiceFailure;
      if(selectedAudioBytes<19200){
        stream?.cancel();
        state.notice=state.settings.mic==='glasses'&&state.settings.speakerFilter!=='all'&&captureBytes>=19200
          ?classifiedAudioBytes===0
            ?text('話者を判定できませんでした\n録音対象を「すべて」に変更してください','Unable to classify voices\nSelect all voices in Settings')
            :text('選んだ話者の音声が不足しています\nもう少し長く話してください','Not enough audio from the selected speaker\nSpeak for longer')
          :text('もう少し長く話してください','Speak for at least 0.6 seconds');
        feedback={kind:'done',body:state.notice};return;
      }
      let req:RelayRequest;
      if(stream){
        let transcript:string;
        try{transcript=await stream.finish();}catch(e){if(cancelled()){cancelNotice();return;}throw e;}
        if(cancelled()){cancelNotice();return;}
        state.transcript=transcript;
        if(!transcript){feedback={kind:'done',body:text('音声を認識できませんでした\nもう一度録音してください','No speech recognized\nRecord again')};return;}
        req=voiceRequest(transcript);
      }else{
        req=voiceRequest('');
        req.audio={mime:'audio/wav',name:'voice.wav',data_base64:base64(wav(capture, state.settings.relay === 'gadget' && captureBytes > 1_099_956))};
      }
      voiceSending=true;voiceStatus=text('送信中…','Sending…');void render().catch(error);
      state.busy=false;await send(req);if(!target)sentChatId=req.id;
      feedback={kind:'done',body:text('送信しました\nMuse の応答を待っています','Sent\nWaiting for Muse'),waitForReply:!target};
      if(target)state.spaceAction={spaceId:target.spaceId,itemId:target.itemId,status:'sent',message:text('中継が受け付けました','Accepted by relay')};
    }catch(e){if(target)state.spaceAction={spaceId:target.spaceId,itemId:target.itemId,status:'error',message:failureText(e)};throw e;
    }finally{if(target){if(feedback)feedback.back=spaceBack;if(state.spaceAction?.status==='recording')state.spaceAction=undefined;}
      recordingSpace=undefined;stream?.cancel();soniox=undefined;capture=[];captureBytes=0;selectedAudioBytes=0;classifiedAudioBytes=0;voiceBusy=false;voiceSending=false;voiceFailure=undefined;state.busy=false;pendingStop=undefined;emit();
      if(sentChatId&&state.settings.returnToChatAfterSend)await returnToSentChat(sentChatId);else await render().catch(error);}
  }
  function handleEvent(e:EvenHubEvent){
    if(e.audioEvent){ingest(e.audioEvent);return;}
    if(disposed)return;
    if(e.sysEvent?.eventType === 8){
      const pitch = e.sysEvent.imuData && headPitch(e.sysEvent.imuData);
      if (pitch === undefined || !active || contextualOpen || !imuRequested) return;
      if (calibration) { calibration.sample(pitch); return; }
      const s = state.settings;
      if (s.headWake && raise.sample(pitch - s.neutralPitch, s.headWakeAngle, Date.now())
        && state.displaySleeping && !state.busy && !voiceBusy && state.persistence !== 'loading') {
        if (s.headWakeMic && s.configured) fire(act(() => startRecording('head'), undefined, undefined, false));
        else fire(restoreDisplay());
      }
      return;
    }
    if(state.persistence==='loading'&&e.menuItemClickEvent)return;
    if(e.menuItemClickEvent){
      const id=e.menuItemClickEvent.itemID;
      const actions:Record<number,()=>Promise<void>>={
        1:refreshFromGlasses,2:()=>act(async()=>{if(screen==='message'&&state.selectedMessageId)await api.hideMessage(state.selectedMessageId);}),
        3:()=>act(showMenu),4:()=>act(()=>api.toggleRecording(),undefined,undefined,false),
        5:()=>act(showSpaces),6:()=>act(showChat),7:()=>act(()=>stopRecording(true),undefined,undefined,false),
        8:()=>act(async()=>{if(state.recording||voiceBusy||state.busy)return;spaceLayouts.set(spaceId,spaceLayout()==='list'?'cards':'list');await spaceBack();}),
        9:()=>act(async()=>{if(!state.recording&&!voiceBusy&&!state.busy)await showSpaceItems();}),
        10:restoreDisplay,
        11:()=>act(async()=>{page=0;await api.saveSettings({...state.settings,chatLayout:state.settings.chatLayout==='exchange'?'single':'exchange'});}),
      };
      const action=state.displaySleeping?restoreDisplay:id===undefined?undefined:actions[id];
      syncDisplayTimers(true);
      if(action){if(contextualOpen)pendingMenuAction=action;else fire(action());}return;
    }
    // System overlay/lifecycle events take priority over container metadata.
    if(!e.sysEvent&&!e.listEvent&&!e.textEvent)return;
    const type=e.sysEvent?.eventType??e.listEvent?.eventType??e.textEvent?.eventType??0;
    if(state.persistence==='loading'&&![4,5,6,7].includes(type))return;
    // 4 -> menu selection -> 5 is the OS contextual overlay, not app teardown.
    if(type===4){raise.reset();calibration?.cancel();contextualOpen=true;++renderSerial;glasses.invalidateRender();syncDisplayTimers();return;}
    if(type===5){contextualOpen=false;const action=pendingMenuAction;pendingMenuAction=undefined;syncDisplayTimers(true);if(active)fire(action?action():state.displaySleeping?restoreDisplay():render());return;}
    if(type===6||type===7){active=false;disposed=true;calibration?.cancel();fire(syncImu());replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();contextualOpen=false;pendingMenuAction=undefined;++actionSerial;clearTimeout(poll);syncDisplayTimers();foregroundAbort.abort();fire(stopRecording(true));fire(save());glasses.disconnect();return;}
    if(contextualOpen||!active)return;
    if([0,1,2,3,9,10].includes(type))syncDisplayTimers(true);
    if(state.displaySleeping){
      if(type===9){displayInteraction();fire(act(()=>startRecording('hold'),undefined,undefined,false));}
      else if([0,1,2,3].includes(type))fire(restoreDisplay());
      return;
    }
    if(type===9){if(!['space','space-list','space-control'].includes(screen))fire(act(()=>startRecording('hold'),undefined,undefined,false));return;}
    if(type===10){if(recordingMode==='hold')fire(act(()=>stopRecording(false),undefined,undefined,false));return;}
    if(type===3){
      if(state.recording||voiceBusy){fire(act(()=>stopRecording(true),undefined,undefined,false));return;}
      if(feedback){++actionSerial;const back=feedback.back;feedback=undefined;fire(act(back||render));return;}
      if(screen==='space-control')fire(act(spaceBack));
      else if(screen==='space')fire(act(spaceLayout()==='list'?showSpaceItems:showSpaces));
      else if(screen==='space-list')fire(act(showSpaces));
      else if(screen==='home')fire(act(()=>glasses.exit(),undefined,undefined,false));else fire(act(showMenu));return;
    }
    if(type===0){
      if(state.recording){fire(act(()=>stopRecording(false),undefined,undefined,false));return;}if(voiceBusy)return;
      if(feedback){
        const pages=feedbackPages(),index=feedback.page||0;
        if(index<pages.length-1){feedback.page=index+1;fire(render());return;}
        if(feedback.kind==='busy')return;
        const retry=feedback.retry,back=feedback.back;feedback=undefined;fire(retry?retry():act(back||render));return;
      }
      if(e.listEvent){
        if(['home','spaces','space-list','space-control'].includes(screen)){
          const action=menuActions[e.listEvent.currentSelectItemIndex??0];
          if(action)fire(act(action,undefined,undefined,!(screen==='home'&&(e.listEvent.currentSelectItemIndex??0)===2)));
        }return;
      }
      if(screen==='space-control'&&spaceEditor){const {target,value}=spaceEditor;
        if((target.control.type==='button'||target.control.type==='slider')&&page<editorPages().length-1){page++;fire(act(render));return;}
        fire(act(()=>dispatchSpaceAction(spaceRequest(target,value)),undefined,undefined,false));return;}
      if(screen==='space'&&currentSpaceItem()?.control){
        if(page<controlPages(currentSpaceItem()!).length-1){page++;fire(act(render));return;}
        fire(act(()=>activateSpaceItem(spaceId,spaceItemId),undefined,undefined,false));return;
      }
      if(screen==='message'||screen==='space'){page++;fire(act(render));}return;
    }
    if(type===1||type===2){if(state.recording||voiceBusy)return;
      if(feedback)return;
      if(screen==='space-control'&&spaceEditor?.target.control.type==='slider'){
        const c=spaceEditor.target.control;spaceEditor.value=sliderValue(c,Number(spaceEditor.value)+(type===1?c.step:-c.step));fire(act(render));return;
      }
      if(screen==='space'){const s=state.snapshot.spaces.find(s=>s.id===spaceId);if(s?.items.length){spaceItem=(spaceItem+(type===1?-1:1)+s.items.length)%s.items.length;spaceItemId=s.items[spaceItem]!.id;}page=0;fire(act(render));return;}
      if(['home','spaces','space-list','space-control'].includes(screen))return;
      const all=visible(),chatOptions={legacy:state.settings.relay==='gist'},exchange=state.settings.chatLayout==='exchange'?chatExchange(all,state.selectedMessageId||'',chatOptions):undefined;
      const messages=state.settings.chatLayout==='exchange'?chatEntries(all,chatOptions):all;
      const anchor=exchange?.reply?.id||exchange?.input.id||state.selectedMessageId,index=messages.findIndex(m=>m.id===anchor);
      const next=(index+(type===1?-1:1)+messages.length)%messages.length;
      if(messages[next])fire(act(()=>api.showMessage(messages[next]!.id)));
    }
  }
  const api:AppController={state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    saveSettings:settings=>guarded(()=>persistSettings(settings)),
    reloadSettings:()=>guarded(loadSettings),
    async checkConnection(settings=state.settings){return guarded(async()=>makeRelay(validateSettings({...settings,voice:'muse'})).read());},
    refresh:()=>guarded(()=>refresh(true)),
    async sendText(value,image){await guarded(async()=>{const textValue=value.trim();if(!textValue&&!image)return;
      if(textValue.length>10000)throw new Error('Message too long');const req=request(textValue);if(image)req.image=image;await send(req);await returnToSentChat(req.id);});},
    toggleRecording:()=>guarded(()=>state.recording?stopRecording(false):startRecording()),
    cancelRecording:()=>guarded(()=>stopRecording(true)),
    async pickImage(source){return guarded(async()=>{if(!state.settings.images)return null;
      if(glasses.bridge){const image=await glasses.run(b=>source==='camera'?b.captureImageFromCamera():b.pickImageFromAlbum());
        if(!image)return null;return resizeImage({mime:image.mimeType,name:image.name,data_base64:image.base64.replace(/^data:[^,]+,/, '')});}
      return new Promise<Attachment|null>((resolve,reject)=>{const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';
        if(source==='camera')input.setAttribute('capture','environment');input.oncancel=()=>resolve(null);
        input.onchange=()=>{const file=input.files?.[0];if(!file){resolve(null);return;}if(file.size>20_000_000){reject(new Error('Image too large'));return;}
          const reader=new FileReader();reader.onload=()=>{resizeImage({mime:file.type,name:file.name,data_base64:String(reader.result).split(',')[1]!}).then(resolve,reject);};reader.onerror=()=>reject(new Error('Image read'));reader.readAsDataURL(file);};input.click();});});},
    showMessage:id=>guarded(()=>openMessage(id)),
    async loadMessageImage(id){await guarded(async()=>{const m=state.snapshot.messages.find(m=>m.id===id);if(!state.settings.images||!m?.image_file||m.image||!relay)return;
      m.image=await imageAttachment(m.image_file,m.mime_type||'image/png');emit();});},
    async markRead(ids){await guarded(async()=>{
      if(!persistenceReady||state.persistence==='loading')return;
      const existing=new Set(state.snapshot.messages.map(m=>m.id));
      const previous=state.readIds;
      const read=[...new Set([...previous,...ids.filter(id=>existing.has(id))])];
      // Keep read messages in the current snapshot when trimming older history.
      const next=[...read.filter(id=>!existing.has(id)),...read.filter(id=>existing.has(id))].slice(-300);
      const savedLength=next.length;
      state.readIds=next;emit();
      try{await save(true);}
      catch(e){
        if(state.readIds===next)state.readIds=[...previous,...next.slice(savedLength)];
        throw e;
      }
    });},
    async hideMessages(ids){await guarded(async()=>{
      if(!persistenceReady||state.persistence==='loading')return;
      const existing=new Set(state.snapshot.messages.map(m=>m.id));
      state.hiddenIds=[...new Set([...state.hiddenIds,...ids.filter(id=>existing.has(id))])].slice(-300);
      for(const id of ids){awaitingReplies.delete(id);autoHiddenReplies.delete(id);}
      if(state.selectedMessageId&&state.hiddenIds.includes(state.selectedMessageId)){
        state.selectedMessageId=visible()[0]?.id;page=0;feedback=undefined;
      }
      emit();await save(true);await render();
    });},
    async restoreHiddenMessages(){await guarded(async()=>{if(!persistenceReady||state.persistence==='loading')return;state.hiddenIds=[];emit();await save(true);await render();});},
    hideMessage:id=>api.hideMessages([id]),
    async showSpace(id,itemId){await guarded(async()=>{const s=state.snapshot.spaces.find(s=>s.id===id);if(!s)return;
      if(state.recording||voiceBusy)return;
      displayInteraction();followingChatId=undefined;
      spaceId=id;spaceItem=Math.max(0,s.items.findIndex(i=>i.id===itemId));spaceItemId=s.items[spaceItem]?.id||'';spaceListPage=Math.floor(spaceItem/18);
      screen=itemId||spaceLayout(s)==='cards'?'space':'space-list';spaceEditor=undefined;page=0;feedback=undefined;state.error='';glasses.invalidateImage();
      await render();emit();});},
    async selectSpaces(ids){if(!persistenceReady||state.persistence==='loading')return;
      state.selectedSpaceIds=[...new Set(ids.filter(id=>typeof id==='string'&&id.length>0&&id.length<=128))].slice(0,15);
      await save(true);
      if(['space','space-list','space-control'].includes(screen)&&!state.selectedSpaceIds.includes(spaceId)&&!state.recording&&!voiceBusy){screen='spaces';spaceEditor=undefined;feedback=undefined;}
      emit();if(screen==='spaces')await render();},
    async requestSpace(id){await guarded(async()=>{const req=request('');req.kind='space';req.space_id=id;await send(req);});},
    activateSpaceItem:(id,itemId)=>guarded(()=>activateSpaceItem(id,itemId)),
    submitSpaceAction:(id,itemId,value)=>guarded(async()=>{
      if(state.recording||voiceBusy||state.busy)throw new Error('Busy');
      displayInteraction();followingChatId=undefined;
      const target=controlTarget(id,itemId);spaceId=id;spaceItemId=itemId;
      spaceItem=state.snapshot.spaces.find(s=>s.id===id)!.items.findIndex(i=>i.id===itemId);spaceListPage=Math.floor(spaceItem/18);
      if(target.control.type==='microphone'){await startRecording('toggle',target);return;}
      await dispatchSpaceAction(spaceRequest(target,value));
    }),
    showGlassesMenu:()=>guarded(showMenu),
    measureNeutralPitch,
    restoreDisplay:()=>guarded(restoreDisplay),
    async clearCredentials(){await guarded(async()=>{await stopRecording(true);await persistSettings({...defaults,theme:state.settings.theme,language:state.settings.language},true);});},
  };
  async function startGlasses(){
    if(disposed)return;
    try{await glasses.start();state.glasses=true;fire(syncImu());emit();await render();}
    catch{if(!state.notice)state.notice=text('グラス表示を開始できません。設定はスマートフォンで確認できます。','Unable to start the glasses display. Your settings are available on the phone.');emit();}
  }
  let initialRestoreDone=false;
  const onHostReady=()=>{
    if(disposed||!initialRestoreDone||nativeHost||!detectNativeHost())return;
    fire(loadSettings().then(startGlasses));
  };
  window.addEventListener('evenAppBridgeReady',onHostReady);
  window.addEventListener('languagechange',()=>{if(!disposed&&state.settings.language==='system'){emit();fire(render());}});
  document.addEventListener('evenAppBridgeReady',onHostReady);
  void (async()=>{
    await waitForHost();await loadSettings();initialRestoreDone=true;
    if(!nativeHost&&detectNativeHost())await loadSettings();
    if(disposed)return;
    if(nativeHost)await startGlasses();
    else{state.notice=text('グラスと音声は Even アプリから利用できます。','Open in the Even app for glasses and voice.');emit();}
  })().catch(error);
  document.addEventListener('visibilitychange',()=>{
    if(disposed)return;
    // The Even host keeps this WebView alive for the glasses while the phone is hidden.
    // Phone visibility is not the glasses page lifecycle (nor the contextual overlay).
    if(nativeHost){fire(save());if(!document.hidden)fire(render());return;}
    if(document.hidden){active=false;contextualOpen=false;pendingMenuAction=undefined;++actionSerial;++renderSerial;glasses.invalidateRender();clearTimeout(poll);syncDisplayTimers();foregroundAbort.abort();fire(stopRecording(true));fire(save());}
    else{active=true;contextualOpen=false;foregroundAbort=new AbortController();if(feedback?.kind==='busy')feedback=undefined;fire(render());armPoll(0);}
  });
  window.addEventListener('pagehide',()=>{active=false;disposed=true;calibration?.cancel();fire(syncImu());++renderSerial;glasses.invalidateRender();replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();++actionSerial;clearTimeout(poll);syncDisplayTimers();foregroundAbort.abort();fire(stopRecording(true));fire(save());});
  return api;
}
