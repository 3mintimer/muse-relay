import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { ImuReportPace, AudioInputSource, AudioSpeakerRole } from '@evenrealities/even_hub_sdk';
import { getTextWidth } from '@evenrealities/pretext';
import type { AppController, AppState, Attachment, Message, Relay, RelayRequest, Settings, SpaceItem, SpaceControl, MuseProfile } from './types';
import { motionKinds, type MotionKind } from './types';
import { AvatarMotions, avatarDisplay } from './motions';
import { connectionSignature, defaults, httpsConnection, validateSettings } from './config';
import { GistRelay } from '../relay/gist';
import { HttpsRelay } from '../relay/gadget';
import { Glasses, glassBodyRows, type GlassTextStyle } from './glasses';
import { contextItem, contextItems, promptMenuItems, type ContextAction } from './context-menu';
import { glassSettings, type GlassSettingKey } from './glass-settings';
import { excerpt, G2_TEXT_LIMIT, paginate, wrapLines } from './glass-text';
import { base64, hasAudiblePcm, resizeImage, wav } from './media';
import { RelayVoiceSession, SonioxStream } from './soniox';
import { LOCAL_STATE_KEY, StateStorage, type SavedState } from './persistence';
import { resolveLocale, translate } from './i18n';
import { ChatLocationCache, hideEchoedLocation } from './location';
import { HeadRaise, headPitch } from './head-wake';
import { ReplyPoll } from './reply-poll';
import { matchesSpaceAction, sliderValue } from '../../protocol/space-controls.mjs';
import { chatEntries, chatExchange, unreadMessageIds, chatText, displayableMuseReply, type SentChat } from './chat';

const HEAD_END_GRACE_MS = 1000;

type GlassPage={body:string;footer:string;image?:boolean};
interface ChatPage {
  body: string;
  footer: string;
  messageId?: string;
  photo?: Message;
  style?: GlassTextStyle;
  readReplyId?: string;
  working?:boolean;
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
  const motions=new AvatarMotions();
  const state:AppState={motions:motions.state,persistence:'loading',settingsLoadFailed:false,settings:{...defaults},snapshot:{messages:[],spaces:[]},connected:false,glasses:false,displaySleeping:false,busy:false,
    recording:false,transcript:'',error:'',notice:'',readIds:[],hiddenIds:[],selectedSpaceIds:[]};
  const listeners=new Set<()=>void>();
  let relay:Relay|undefined,poll:ReturnType<typeof setTimeout>,saveTimer:ReturnType<typeof setTimeout>;
  let hasLiveSnapshot=false;
  let active=true,disposed=false,screen:'home'|'usage'|'settings'|'message'|'spaces'|'space-list'|'space'|'space-control'='home',page=0,spaceId='',spaceItem=0,spaceListPage=0,spaceItemId='';
  let editingSetting: GlassSettingKey | undefined;
  const spaceLayouts=new Map<string,'list'|'cards'>();
  type ControlTarget={spaceId:string;itemId:string;title:string;control:SpaceControl};
  let spaceEditor:{target:ControlTarget;value?:number|string}|undefined,recordingSpace:ControlTarget|undefined;
  let readJob:Promise<void>|undefined,contextualOpen=false,pendingMenuAction:(()=>Promise<void>)|undefined;
  let feedback:{kind:'busy'|'done'|'error';body:string;retry?:()=>Promise<void>;back?:()=>Promise<void>;page?:number}|undefined;
  let actionSerial=0,renderSerial=0,voiceStatus='',recordingMode:'hold'|'toggle'|'head'='toggle';
  let capture:Uint8Array[]=[],captureBytes=0,voiceBusy=false,voiceSending=false,recordingTimeout:ReturnType<typeof setTimeout>;
  let selectedAudioBytes=0,classifiedAudioBytes=0;
  let pendingStop:'send'|'cancel'|undefined;
  let voiceFailure:unknown;
  let soniox:SonioxStream|RelayVoiceSession|undefined,liveUpdate:ReturnType<typeof setTimeout>|undefined;
  let headEndTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAudibleFrameAt = -Infinity;
  let foregroundAbort=new AbortController();
  const localSent:Message[]=[];
  function mergeSentInput(messages:Message[],sent:Message){
    const echo=messages.find(message=>message.id===sent.id);
    if(!echo)messages.push({...sent});
    else if(echo.from==='You'){
      if(sent.sentLocation)echo.sentLocation=sent.sentLocation;
      // Keep the latest known transcript across empty echoes and snapshots missing this row.
      if(sent.type==='voice-note'&&chatText(echo).trim())sent.text=echo.text;
      else if(chatText(sent).trim())echo.text=sent.text;
    }
  }
  const replyPoll=new ReplyPoll();
  let usageTimeout: ReturnType<typeof setTimeout> | undefined;
  const usageWaiting = () => state.usage?.status === 'waiting';
  const usageTitle = () => text('使用状況確認', 'Usage');
  const usagePrefix = 'r_usage_';
  let overlayPrompts: string[] | undefined;
  let deliveryNotice:{sent:SentChat;message:string}|undefined;
  // Session-only: restored history can never arm an automatic reply wake.
  const awaitingReplies=new Map<string,Set<string>>();
  let autoHiddenReplies=new Set<string>();
  let drawingChatFrame: number | undefined;
  let lastChatPage: {frame: number; key: string; inlineImage?: string; ready: Promise<void>} | undefined;
  let menuActions:Array<()=>Promise<void>>=[];
  let displayTimer:ReturnType<typeof setTimeout>|undefined,displayDeadline=0;
  let followingChat:(SentChat & {targetId:string; animated?:boolean})|undefined;
  let homeClockTimer:ReturnType<typeof setTimeout>|undefined;
  let avatarJob:Promise<void>|undefined,avatarFailedKey='',avatarRetryKey='',avatarRetryAfter=0;
  const glasses=new Glasses(handleEvent,options.bridgeFactory);
  const locationCache = new ChatLocationCache(() => emit());
  function syncLocation(restart = false) {
    const enabled = !disposed && state.settings.configured && state.settings.shareLocation;
    locationCache.configure(enabled ? glasses.bridge : undefined, state.settings.locationIntervalMinutes, restart && enabled);
  }
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
  function contextActions(): ContextAction[] {
    if (state.displaySleeping) return ['wake'];
    if (state.recording) return ['sendRecording', 'cancelRecording'];
    if (voiceBusy) return voiceSending ? [] : ['cancelRecording'];
    if (feedback || screen === 'settings' || screen === 'usage') return ['home'];
    if (screen === 'home') return ['markAllRead'];
    if (screen === 'message') return ['markAllRead', 'spaces'];
    if (screen === 'spaces') return ['chat'];
    return ['items', spaceLayout() === 'list' ? 'cards' : 'list', 'chat', 'spaces'];
  }
  const chatPromptMenu = () => screen === 'message' && !feedback && !state.displaySleeping && !state.recording && !voiceBusy
    ? promptMenuItems(state.settings.savedPrompts) : [];
  const contextualMenu = () => [
    ...contextActions().map(action => contextItem(action, state.settings.language)),
    ...chatPromptMenu().map(({itemID, itemName}) => ({itemID, itemName})),
  ];
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
  const show=(body:string,footer='',image?:Attachment,style?:GlassTextStyle,messageId?:string)=>active&&!contextualOpen
    ?glasses.show(state,body,footer,image,contextualMenu(),style,messageId):Promise.resolve();
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
  function motionChanged(kind:MotionKind) {
    if ((kind==='idle' && homeClockVisible()) || (kind==='working' && screen==='message' && followingChat)) {
      lastChatPage=undefined;
      fire(render());
    }
    emit();
  }
  function syncMotions(retry=false) {
    for(const kind of motionKinds) fire(motions.sync(kind,state.snapshot.motions?.[kind],state.settings.images && active && !disposed,
      file=>imageAttachment(file,'image/png'),()=>motionChanged(kind),retry));
  }
  function glassMotion(kind:MotionKind) {
    const frames=avatarDisplay(state,kind)==='animation' && state.motions[kind].frames;
    if(!frames) return;
    return {frames,failed:()=>{motions.playbackFailed(kind,frames);motionChanged(kind);}};
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
  async function act(action:()=>Promise<void>,pending?:string,retry=true){
    if(disposed||!active)return;
    const id=++actionSerial;
    feedback=pending?{kind:'busy',body:pending}:undefined;
    state.error='';emit();
    try{
      if(pending)await render();
      await action();
      if(id===actionSerial&&pending){feedback=undefined;await render();}
    }catch(e){
      error(e);
      if(id!==actionSerial||!active||disposed)return;
      feedback=failureFeedback(e,retry?()=>act(action,pending,retry):undefined);
      await render().catch(error);
    }
  }
  const visible=()=>state.snapshot.messages.filter(m=>!state.hiddenIds.includes(m.id)).sort((a,b)=>a.ts-b.ts);
  const chatOptions=()=>({legacy:state.settings.relay==='gist', following:followingChat, images:state.settings.images});
  function currentExchange(messages:Message[], selectedId:string) {
    const id=followingChat?.targetId===selectedId ? followingChat.id : selectedId;
    return chatExchange(messages,id,chatOptions());
  }
  function followedMessage(){
    if(!followingChat)return;
    const turn=chatExchange(visible(),followingChat.id,chatOptions());
    return turn?.reply ?? turn?.input;
  }
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
    resetUsage();
    locationCache.configure();
    const generation=++settingsGeneration;
    replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();
    state.persistence='loading';state.settingsLoadFailed=false;clearTimeout(poll);clearTimeout(saveTimer);emit();
    const result=await storage.load();
    if(generation!==settingsGeneration||result.stale)return;
    if(result.value){
      const saved=result.value;state.settings=saved.settings;state.snapshot=saved.snapshot;
      state.readIds=saved.readIds;state.hiddenIds=saved.hiddenIds;state.selectedSpaceIds=saved.selectedSpaceIds;
      configureRelay(state.settings);
    }
    syncLocation();
    persistenceReady=result.writable;state.persistence=result.mode;state.settingsLoadFailed=result.failed;
    raise.reset();fire(syncImu());
    document.documentElement.dataset.evenTheme=state.settings.theme;syncProfileAvatar();syncMotions();emit();armPoll(0);
  }
  const savedNotice=(mode:AppState['persistence'])=>mode==='native'
    ?text('Evenアプリに設定を保存しました。','Settings saved in the Even app.')
    :nativeHost?text('端末のバックアップに保存しました。Even側への保存は未確認です。','Saved to the device backup. Saving in Even is not confirmed.')
      :text('このブラウザーに設定を保存しました。','Settings saved in this browser.');
  async function persistSettings(settings:Settings,clear=false){
    if(state.recording||voiceBusy||savingSettings||state.busy)throw new Error('Busy');
    if(!clear&&!persistenceReady&&!settings.configured)throw new Error('Settings read failed');
    const checked=validateSettings(settings,settings.configured);
    const resetHistory = clear || connectionSignature(checked) !== connectionSignature(state.settings);
    const connectionChanged = resetHistory || checked.configured !== state.settings.configured;
    ++settingsGeneration;savingSettings=true;state.busy=true;clearTimeout(saveTimer);emit();
    const saved=resetHistory?{settings:checked,snapshot:{messages:[],spaces:[]},readIds:[],hiddenIds:[],selectedSpaceIds:[]}: {...serializable(),settings:checked};
    try{
      const mode=await storage.save(saved,true);
      if (resetHistory) locationCache.configure();
      state.settings=checked;
      syncLocation();
      if(!checked.autoHideSeconds){state.displaySleeping=false;autoHiddenReplies.clear();}
      if(!checked.returnToChatAfterSend&&screen!=='message')followingChat=undefined;
      displayDeadline=0;
      if(resetHistory){state.snapshot=saved.snapshot;state.readIds=saved.readIds;state.hiddenIds=saved.hiddenIds;state.selectedSpaceIds=saved.selectedSpaceIds;}
      if(connectionChanged){resetUsage();followingChat=undefined;replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();foregroundAbort.abort();foregroundAbort=new AbortController();readJob=undefined;configureRelay(checked);delete state.snapshot.profile;delete state.snapshot.motions;delete state.snapshot.capabilities;avatarFailedKey='';}
      persistenceReady=true;state.persistence=mode||'unavailable';state.settingsLoadFailed=false;state.error='';
      state.notice=clear?(mode==='native'?text('接続情報を削除しました。','Connection details removed.')
        :nativeHost?text('端末の接続情報を削除しました。Even側の削除は未確認です。','Device connection details removed. Removal in Even is not confirmed.')
          :text('このブラウザーの接続情報を削除しました。','Connection details removed from this browser.')):savedNotice(state.persistence);
      if (resetHistory) {
        localSent.length = 0; deliveryNotice = undefined; lastChatPage = undefined;
        state.selectedMessageId = undefined; state.spaceAction = undefined; state.lastSync = undefined;
        spaceId = ''; spaceItemId = ''; spaceLayouts.clear(); spaceEditor = undefined;
        ++actionSerial; pendingMenuAction = undefined; contextualOpen = false; menuActions = [];
        screen = 'home'; page = 0; feedback = undefined;
      }
      raise.reset();fire(syncImu());
      document.documentElement.dataset.evenTheme=checked.theme;
      try{localStorage.setItem('muse-relay-theme',checked.theme);}catch{/* Cosmetic preference only. */}
      emit();if(connectionChanged)armPoll(0);else armPoll();
    }catch(e){if(state.persistence==='loading')state.persistence='unavailable';throw e;}
    finally{
      savingSettings=false;state.busy=false;syncProfileAvatar();syncMotions();emit();
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
  function makeRelay(settings:Settings):Relay{return settings.relay==='gist'?new GistRelay(settings):new HttpsRelay(settings);}
  function configureRelay(settings:Settings){
    const address=settings.relay==='gist'?settings.gistId:httpsConnection(settings).url;
    motions.restore(JSON.stringify([settings.relay,address]));
    relay=settings.configured?makeRelay(settings):undefined;
    hasLiveSnapshot=false;state.connected=false;
  }
  function armPoll(delay=replyPoll.delay(Math.min(state.settings.pollSeconds*1000, usageWaiting()?5000:Infinity))){clearTimeout(poll);if(active&&relay&&!disposed)poll=setTimeout(()=>fire(refresh()),delay);}
  function chatPage(): ChatPage {
    const messages=visible(),selected=messages.find(m=>m.id===state.selectedMessageId);
    if(!selected)return {body:text('メッセージはありません\n録音またはスマートフォンから送信','No messages yet\nRecord voice or send from your phone'),footer:text('ダブルタップ: ホーム','Double-tap: home')};
    const exchange=state.settings.chatLayout==='exchange'?currentExchange(messages,selected.id):undefined;
    const message=exchange?.reply||exchange?.input||selected;
    const messageText=(m:Message)=>chatText(m)||(m.type==='image'?text('画像','Image'):text('音声メッセージ','Voice message'));
    const stamp=(m:Message)=>new Date(m.ts*1000).toLocaleString(resolveLocale(state.settings.language),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    let input:string|undefined;
    if(exchange?.reply && !(followingChat?.animated && selected.id===followingChat.targetId)){
      const original=messages.find(m=>m.id===exchange.input.reply_to&&m.from==='You')??exchange.input;
      input=excerpt(translate(state.settings.language,'あなた: {text}','You: {text}',{text:`${stamp(original)} · ${messageText(exchange.input)}`}),2);
    }
    const body=exchange?.reply?`${message.from}: ${messageText(message)}`:`${message.from} · ${stamp(message)}\n${messageText(message)}`;
    const hasImage=state.settings.images&&Boolean(message.image||message.image_file);
    const waiting=message.from==='You'&&selected.id===followingChat?.targetId?text('Muse の返信待ち','Waiting for Muse')+'\n':'';
    if(waiting && glassMotion('working')) return {body:waiting.trim(),footer:text('2回タップ: ホーム','Double-tap: home'),messageId:message.id,working:true};
    const pages=bodyPages(body,(index,total)=>`${waiting}${index+1}/${total} · ${index<total-1
      ?text('タップ: 次のページ · 2回: ホーム','Tap: next page · Double-tap: home'):text('2回タップ: ホーム','Double-tap: home')}`,input,hasImage);
    if(page>=pages.length)page=0;
    const current=pages[page]!;
    return {body:current.body,footer:current.footer,messageId:message.id,readReplyId:exchange?.reply?.id,
      photo:current.image?message:undefined,style:current.image?undefined:{input,bodyColor:message.from==='You'?1:4}};
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
    if(view.working) {
      const motion=glassMotion('working');
      if(motion && followingChat) {
        followingChat.animated=true;
        await glasses.waiting(state,view.body,view.footer,contextualMenu(),view.messageId!,motion);
        return;
      }
    }
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
    await show(view.body,view.footer,image,view.style,view.messageId);
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
    if(screen==='usage'){
      const pages = usagePages();
      page = Math.min(page, pages.length - 1);
      await show(pages[page]!.body, pages[page]!.footer);
      return;
    }
    if(screen==='home'){
      const prompts = promptMenuItems(state.settings.savedPrompts);
      menuActions=[showChat,showSpaces,showSettings,openUsage,...prompts.map(({slot})=>()=>sendPreset(slot,true))];
      const dateTime=new Date().toLocaleString(resolveLocale(state.settings.language),{
        year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
      });
      const items=[text('チャット','Chat'),text('スペース','Spaces'),text('設定','Settings'),usageTitle(),...prompts.map(p=>p.itemName)];
      const footer=text('タップ: 開く · 2回: 終了','Tap: open · Double-tap: exit');
      const avatar=avatarDisplay(state,'idle')==='still'?state.snapshot.profile?.avatar:undefined;
      try{await glasses.list(state,items,footer,contextualMenu(),dateTime,avatar,glassMotion('idle'));}
      catch(e){
        if(!avatar)throw e;
        if(frame!==renderSerial)return;
        avatarFailedKey=avatarKey();state.avatarStatus='error';
        await glasses.list(state,items,footer,contextualMenu(),dateTime);emit();
      }
      return;
    }
    if (screen === 'settings') {
      const fields = glassSettings(state.settings);
      const field = fields.find(entry => entry.key === editingSetting);
      const footer = text('タップ: 選択 · 2回: 戻る', 'Tap: select · Double-tap: back');
      if (field) {
        menuActions = field.options.map(option => async () => {
          if (state.busy || option.selected) return;
          await api.saveSettings({ ...state.settings, ...option.change });
        });
        const labels = field.options.map(option => (option.selected ? '✓ ' : '') + option.label);
        await glasses.list(state, labels, footer, contextualMenu(), field.title);
      } else {
        editingSetting = undefined;
        menuActions = fields.map(entry => async () => { editingSetting = entry.key; await render(); });
        await glasses.list(state, fields.map(entry => entry.title), footer, contextualMenu(), text('設定', 'Settings'));
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
  function usagePages() {
    const body = state.usage?.text || text('Muse の返信待ち', 'Waiting for Muse');
    return bodyPages(body, (index,total) => total > 1 ? `${index+1}/${total} · ${nextBack()}` : text('ダブルタップ: 戻る','Double-tap: back'));
  }
  function resetUsage() {
    clearTimeout(usageTimeout);
    state.usage = undefined;
  }
  function updateUsage(status: 'answer' | 'error', body: string) {
    if (!state.usage || (state.usage.status === status && state.usage.text === body)) return;
    const first = state.usage.status === 'waiting';
    clearTimeout(usageTimeout);
    state.usage = {id: state.usage.id, status, text: body};
    if (screen === 'usage') {
      if (first) displayInteraction();
      fire(render());
    }
    emit();
  }
  async function checkUsage() {
    if (usageWaiting()) return;
    if (state.busy || state.recording || voiceBusy) throw new Error('Busy');
    const current = relay;
    const req = request('Show /subscription-status concisely.', usagePrefix);
    state.usage = {id:req.id, status:'waiting', text:''};
    state.busy = true;
    emit();
    try {
      if (!current) throw new Error('Relay token');
      await current.send(req, foregroundAbort.signal);
      if (current !== relay || state.usage?.id !== req.id || disposed) return;
      if (usageWaiting()) {
        usageTimeout = setTimeout(() => updateUsage('error', text('返信が届いていません。もう一度確認してください。','No reply yet. Check again.')), 120000);
      }
      if (state.settings.relay !== 'gist') replyPoll.sent(req.id);
      armPoll(0);
    } catch (e) {
      if (state.usage?.id === req.id && usageWaiting()) updateUsage('error', failureText(e));
    } finally {
      state.busy = false;
      emit();
    }
  }
  async function openUsage() {
    if (state.recording || voiceBusy || (state.busy && !usageWaiting())) return;
    displayInteraction(); followingChat = undefined; feedback = undefined; page = 0; screen = 'usage';
    const pending = checkUsage();
    await render();
    await pending;
  }
  async function sendPreset(slot:number, fromHome=false) {
    const value = state.settings.savedPrompts[slot];
    if (!value || state.busy || state.recording || voiceBusy) return;
    const sent = await send(request(value), false);
    await returnToSentChat(sent, fromHome && screen === 'home');
  }
  async function showMenu(){
    if(state.recording||voiceBusy)return;
    displayInteraction();followingChat=undefined;
    screen='home';page=0;feedback=undefined;await render();
  }
  async function showSettings() {
    if (state.recording || voiceBusy) return;
    displayInteraction(); followingChat = undefined; editingSetting = undefined;
    screen = 'settings'; page = 0; feedback = undefined; await render();
  }
  async function showChat(){
    if(state.recording||voiceBusy)return;
    displayInteraction();followingChat=undefined;
    const first=visible().at(-1);
    if(first){await api.showMessage(first.id);return;}
    screen='message';state.selectedMessageId=undefined;page=0;feedback=undefined;await render();
  }
  async function showSpaces(){
    if(state.recording||voiceBusy)return;
    displayInteraction();followingChat=undefined;
    screen='spaces';page=0;feedback=undefined;await render();
  }
  async function refresh(explicit=false){
    if(!active)return;
    if(explicit){avatarFailedKey='';avatarRetryAfter=0;syncMotions(true);}
    if(!relay){if(explicit)throw new Error('Relay token');return;}
    // A manual refresh joins the existing read instead of silently doing nothing.
    if (!readJob) {
      const job = readSnapshot().finally(() => { if (readJob === job) readJob = undefined; });
      readJob = job;
    }
    if(explicit)await readJob;else await readJob.catch(()=>{});
  }
  async function readSnapshot(){
    const current=relay!,signal=foregroundAbort.signal;
    try{const snap=await current.read(signal);if(current!==relay||!active||signal.aborted)return;
      const previousAvatarKey=avatarKey();
      if(snap.profile?.avatar_file&&!snap.profile.avatar&&avatarKey(snap.profile)===previousAvatarKey)
        snap.profile.avatar=state.snapshot.profile?.avatar;
      replyPoll.observe(snap.messages);
      if (state.usage) {
        const id = state.usage.id;
        const answer = snap.messages.filter(m => m.reply_to === id && displayableMuseReply(m,false)).at(-1);
        const failure = snap.messages.find(m => m.id === 'status_'+id && m.reply_to === id && m.from === 'Relay');
        if (answer) updateUsage('answer',chatText(answer));
        else if (failure && usageWaiting()) updateUsage('error',failureText(new Error('Relay')));
      }
      snap.messages = snap.messages.filter(m => !m.id.startsWith(usagePrefix) && !m.reply_to?.startsWith(usagePrefix));
      // The saved history can be incomplete. Only compare live snapshots for new arrivals.
      const before=hasLiveSnapshot?new Set(state.snapshot.messages.map(m=>m.id)):undefined;
      const previousMessages=state.snapshot.messages;
      for(const sent of localSent)mergeSentInput(snap.messages,sent);
      // Preserve downloaded attachments while their relay reference/version is unchanged.
      // Otherwise every poll flashes a loading page and needlessly retransmits the image.
      for(const message of snap.messages){
        const previous=state.snapshot.messages.find(m=>m.id===message.id);
        if(message.from==='You' && previous?.sentLocation && previous.ts===message.ts)
          message.sentLocation=previous.sentLocation;
        if(!message.image&&message.image_file&&previous?.image&&previous.image_file===message.image_file
          &&previous.ts===message.ts&&previous.mime_type===message.mime_type)message.image=previous.image;
      }
      for(const reply of snap.messages){
        if(reply.from !== 'Muse' || !reply.reply_to)continue;
        const fix=snap.messages.find(m=>m.id===reply.reply_to && m.from==='You')?.sentLocation;
        if(fix)reply.text=hideEchoedLocation(reply.text,fix,text('現在地','Location'));
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
      snap.messages.sort((a,b)=>a.ts-b.ts);state.snapshot=snap;hasLiveSnapshot=true;syncProfileAvatar();state.connected=true;state.lastSync=Date.now();if(feedback?.kind!=='error')state.error='';
      const selectedSpace=snap.spaces.find(s=>s.id===spaceId);
      if(spaceItemId&&selectedSpace){const index=selectedSpace.items.findIndex(i=>i.id===spaceItemId);spaceItem=Math.max(0,index);}
      clearAnsweredNotice(snap.messages);
      const arrivedReplies=takeReplies(snap.messages,previousMessages);
      const wakeReplies=screen!=='usage'&&state.displaySleeping&&state.settings.autoHideSeconds&&!state.recording&&!voiceBusy
        &&!state.busy&&!contextualOpen&&!feedback
        ?arrivedReplies.filter(message=>autoHiddenReplies.has(message.reply_to!)):[];
      const wakeReply=wakeReplies.filter(m=>!followingChat||m.reply_to===followingChat.id).at(-1);
      const newMessages=before?snap.messages.filter(m=>!before.has(m.id)&&m.from!=='You'):[];
      const latest=screen==='message' ? followedMessage() : undefined;
      if(wakeReply){
        if(followingChat && wakeReply.reply_to===followingChat.id)followingChat.targetId=wakeReply.id;
        await wakeForReply(wakeReply);
      }else if(latest && followingChat && latest.id!==followingChat.targetId && !state.recording&&!voiceBusy&&!feedback){
        followingChat.targetId=latest.id;state.selectedMessageId=latest.id;page=0;
        if(!state.displaySleeping&&!contextualOpen)await act(()=>openMessage(latest.id,false));
      }else if(!state.displaySleeping&&newMessages.length&&!state.recording&&!voiceBusy&&!contextualOpen&&screen==='home'&&!feedback){
        await act(()=>openMessage(newMessages.at(-1)!.id,false));
      }else if(!state.displaySleeping&&['message','space','spaces','space-list','space-control'].includes(screen)&&!feedback){
        if(screen==='message'&&!visible().some(m=>m.id===state.selectedMessageId))state.selectedMessageId=visible().at(-1)?.id;
        // Relay success remains a relay success even if local image/G2 rendering fails.
        await act(render);
      }
      syncMotions();
      if(homeClockVisible()&&previousAvatarKey!==avatarKey())fire(render());
      emit();saveSoon();armPoll();
    }catch(e){if(!signal.aborted){replyPoll.clear();state.connected=false;error(e);armPoll(Math.max(30000,state.settings.pollSeconds*2000));throw e;}}
  }
  function clearAnsweredNotice(messages:Message[]) {
    if (!deliveryNotice) return;
    const {sent,message}=deliveryNotice;
    if(state.notice!==message){deliveryNotice=undefined;return;}
    const turn=chatExchange(messages,sent.id,{...chatOptions(),following:sent});
    if(turn?.reply){state.notice='';deliveryNotice=undefined;}
  }
  async function send(request:RelayRequest, shareLocation=true){
    if(!relay)throw new Error('Relay token');
    if(state.busy)throw new Error('Busy');
    if(request.image&&state.settings.relay!=='gist'&&state.snapshot.capabilities?.images!==true)throw new Error('Image sending unavailable');
    const current=relay,beforeIds=new Set(state.snapshot.messages.map(message=>message.id));
    // In a legacy Gist, the next unlinked answer could still belong to an earlier open turn.
    const priorTurn=state.settings.relay==='gist'?visible().filter(m=>m.from!=='Relay'&&!m.id.startsWith('status_')).at(-1):undefined;
    const needsReplyId=priorTurn?.from==='You';
    state.busy=true;state.error='';emit();
    const location = shareLocation && request.kind === 'chat' && state.settings.shareLocation ? locationCache.current() : undefined;
    try{await relay.send(location ? {...request, location} : request,foregroundAbort.signal);
      if (current !== relay) return;
      const sent:Message={id:request.id,from:'You',type:request.audio?'voice-note':request.image?'image':'text',text:request.text,ts:request.created_at,
        ...(location ? {sentLocation:location} : {}), ...(request.image?{image:request.image}:{})};
      mergeSentInput(state.snapshot.messages,sent);
      localSent.push(sent);if(localSent.length>50)localSent.shift();
      if(request.kind==='chat'&&current===relay&&active&&!disposed){
        awaitingReplies.set(request.id,beforeIds);
        if(awaitingReplies.size>50)awaitingReplies.delete(awaitingReplies.keys().next().value!);
        takeReplies(state.snapshot.messages); // A response can arrive before the send acknowledgement.
      }
      if(state.settings.relay!=='gist'&&active&&!disposed){replyPoll.sent(request.id);replyPoll.observe(state.snapshot.messages);}
      const turn={id:request.id,previousIds:beforeIds,needsReplyId};
      state.notice=text('中継へ送信しました。Muse の応答を待っています。','Sent to relay. Waiting for Muse.');
      deliveryNotice=request.kind==='chat'?{sent:turn,message:state.notice}:undefined;
      clearAnsweredNotice(state.snapshot.messages);emit();saveSoon();
      if(state.settings.relay!=='gist')armPoll();else armPoll(2000);
      return turn;
    }finally{state.busy=false;emit();}
  }
  const request=(textValue:string, prefix='r_'):RelayRequest=>({id:prefix+crypto.randomUUID(),kind:'chat',text:textValue,created_at:Math.floor(Date.now()/1000)});
  async function openMessage(id:string,interaction=true){
    if(!state.snapshot.messages.some(m=>m.id===id))return;
    if(interaction){displayInteraction();followingChat=undefined;}
    state.selectedMessageId=id;screen='message';page=0;feedback=undefined;state.error='';
    const ready=render(true),frame=renderSerial;
    await ready;
    if(glasses.ready&&active&&!disposed&&frame===renderSerial&&!state.displaySleeping&&!contextualOpen&&!state.recording&&!voiceBusy
      &&screen==='message'&&state.selectedMessageId===id&&!state.readIds.includes(id))state.readIds.push(id);
    emit();saveSoon();
  }
  const shouldShowSentChat=()=>screen==='message'||state.settings.returnToChatAfterSend;
  async function returnToSentChat(sent:SentChat | undefined, force=false){
    if(!sent||(!force&&!shouldShowSentChat())||!active||disposed)return;
    displayInteraction();followingChat={...sent,targetId:sent.id};
    // Resolve from the full snapshot: a transcript or reply can precede the acknowledgement.
    followingChat.targetId=followedMessage()?.id??sent.id;
    await openMessage(followingChat.targetId,false).catch(error);
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
      if(serial===actionSerial&&feedback?.kind==='busy'){await spaceBack().catch(error);return;}
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
    displayInteraction();followingChat=undefined;
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
    fire(act(()=>stopRecording(false),undefined,false));
  }
  function clearHeadEndpoint() {
    clearTimeout(headEndTimer);
    headEndTimer = undefined;
    lastAudibleFrameAt = -Infinity;
  }
  function waitAfterHeadEndpoint() {
    if (!state.recording || pendingStop || headEndTimer !== undefined) return;
    const submit = () => {
      clearHeadEndpoint();
      if (state.recording && !pendingStop) fire(act(() => stopRecording(false), undefined, false));
    };
    headEndTimer = setTimeout(() => {
      // Give resumed speech time to produce a caption. Ambient sound alone can
      // extend the wait once, so a noisy room cannot keep an ended turn open.
      if (Date.now() - lastAudibleFrameAt < HEAD_END_GRACE_MS) headEndTimer = setTimeout(submit, HEAD_END_GRACE_MS);
      else submit();
    }, HEAD_END_GRACE_MS);
  }
  function ingest(audio:NonNullable<EvenHubEvent['audioEvent']>){
    if(!state.recording||pendingStop)return;
    const limit = 120 * 32000;
    const pcm = audio.audioPcm.subarray(0, limit - captureBytes);
    const filter=state.settings.mic==='glasses'?state.settings.speakerFilter:'all';
    const classified=audio.source!==AudioInputSource.Phone&&(audio.speakerRole===AudioSpeakerRole.Self||audio.speakerRole===AudioSpeakerRole.Other);
    const selected=filter==='all'||(classified&&audio.speakerRole===filter);
    if (headEndTimer !== undefined && selected && hasAudiblePcm(pcm)) lastAudibleFrameAt = Date.now();
    if(classified)classifiedAudioBytes+=pcm.length;
    if(selected)selectedAudioBytes+=pcm.length;
    // Keep pauses and recording duration intact; only selected audio reaches either transcriber.
    const audioFrame=selected?pcm:new Uint8Array(pcm.length);captureBytes+=audioFrame.length;
    if(!soniox)capture.push(selected?pcm.slice():audioFrame);
    else try{soniox.push(audioFrame);}catch(e){voiceFailed(e);}
    if (captureBytes === limit) fire(act(() => stopRecording(false), undefined, false));
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
      const relayLiveVoice=state.settings.voice==='muse'&&state.settings.relay!=='gist'&&state.snapshot.capabilities?.live_transcription===true;
      if(state.settings.voice==='soniox'||relayLiveVoice){
        const onText = (value: string) => {
          if(value===state.transcript)return;
          clearHeadEndpoint();
          state.transcript=value;emit();
          if(state.recording&&!liveUpdate)liveUpdate=setTimeout(()=>{liveUpdate=undefined;fire(render());},400);
        };
        const onEndpoint = mode === 'head' ? waitAfterHeadEndpoint : undefined;
        soniox = relayLiveVoice ? new RelayVoiceSession(state.settings, onText, voiceFailed, onEndpoint)
          : new SonioxStream(onText, voiceFailed, onEndpoint);
        // SonioxStream reports failures through voiceFailed and queues audio until ready.
        void soniox.start(state.settings).catch(()=>{});
      }
      await opening;
      state.notice='';
      recordingTimeout=setTimeout(()=>fire(act(()=>stopRecording(false),undefined,false)),120000);
    }catch(e){
      clearHeadEndpoint();
      state.recording=false;recordingSpace=undefined;if(target)state.spaceAction=undefined;
      soniox?.cancel();soniox=undefined;capture=[];clearTimeout(liveUpdate);liveUpdate=undefined;
      await glasses.microphone(false,state.settings.mic==='phone').catch(()=>{});throw e;
    }
    finally{
      voiceBusy=false;state.busy=false;const pending=pendingStop;pendingStop=undefined;emit();
      if(pending&&state.recording){
        // Cleanup must still close a microphone that finished opening after background/exit.
        fire(active&&!disposed?act(()=>stopRecording(pending==='cancel'),undefined,false):stopRecording(true));
      }
    }
    if(state.recording)await render().catch(error);
  }
  async function stopRecording(cancel:boolean){
    clearHeadEndpoint();
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
    let sentChat:SentChat|undefined;
    const voiceRequest=(transcript:string)=>target?spaceRequest(target,undefined,transcript):request(transcript);
    const cancelled=()=>pendingStop==='cancel';
    const cancelNotice=()=>{stream?.cancel();state.notice=text('録音を中止しました','Recording cancelled');};
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
        req.audio={mime:'audio/wav',name:'voice.wav',data_base64:base64(wav(capture, state.settings.relay !== 'gist' && captureBytes > 1_099_956))};
      }
      voiceSending=true;voiceStatus=text('送信中…','Sending…');void render().catch(error);
      state.busy=false;const accepted=await send(req);if(!target)sentChat=accepted;
      if(target)state.spaceAction={spaceId:target.spaceId,itemId:target.itemId,status:'sent',message:text('中継が受け付けました','Accepted by relay')};
    }catch(e){if(target)state.spaceAction={spaceId:target.spaceId,itemId:target.itemId,status:'error',message:failureText(e)};throw e;
    }finally{const cancelledSpace=cancelled();
      if(target){if(feedback)feedback.back=spaceBack;if(state.spaceAction?.status==='recording')state.spaceAction=undefined;}
      recordingSpace=undefined;stream?.cancel();soniox=undefined;capture=[];captureBytes=0;selectedAudioBytes=0;classifiedAudioBytes=0;voiceBusy=false;voiceSending=false;voiceFailure=undefined;state.busy=false;pendingStop=undefined;emit();
      if(sentChat&&shouldShowSentChat())await returnToSentChat(sentChat);
      else if(target&&!feedback&&(cancelledSpace||state.spaceAction?.status==='sent'))await spaceBack().catch(error);
      else await render().catch(error);}
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
        if (s.headWakeMic && s.configured) fire(act(() => startRecording('head'), undefined, false));
        else fire(restoreDisplay());
      }
      return;
    }
    if(state.persistence==='loading'&&e.menuItemClickEvent)return;
    if(e.menuItemClickEvent){
      const id=e.menuItemClickEvent.itemID;
      const preset = chatPromptMenu().find(item => item.itemID === id);
      if (preset) {
        if (state.busy) return;
        const value = (overlayPrompts ?? state.settings.savedPrompts)[preset.slot];
        const action = () => value === state.settings.savedPrompts[preset.slot] && screen === 'message'
          ? act(()=>sendPreset(preset.slot),undefined,false) : render();
        if (contextualOpen) pendingMenuAction = action; else fire(action());
        return;
      }
      const chosen = contextActions().find(action => contextItems[action][0] === id);
      if (!chosen || (state.busy && ['items', 'cards', 'list'].includes(chosen))) return;
      const actions: Record<ContextAction, () => Promise<void>> = {
        home: () => act(showMenu), spaces: () => act(showSpaces), chat: () => act(showChat),
        sendRecording: () => act(() => stopRecording(false), undefined, false),
        cancelRecording: () => act(() => stopRecording(true), undefined, false),
        items: () => act(showSpaceItems),
        cards: () => act(async () => { spaceLayouts.set(spaceId, 'cards'); await spaceBack(); }),
        list: () => act(async () => { spaceLayouts.set(spaceId, 'list'); await spaceBack(); }),
        wake: restoreDisplay,
        markAllRead: () => act(async () => {
          const ids = unreadMessageIds(visible(), state.readIds);
          if (ids.length) await api.markRead(ids);
          await render();
        }),
      };
      const action = actions[chosen];
      syncDisplayTimers(true);
      if(contextualOpen)pendingMenuAction=action;else fire(action());
      return;
    }
    // System overlay/lifecycle events take priority over container metadata.
    if(!e.sysEvent&&!e.listEvent&&!e.textEvent)return;
    const type=e.sysEvent?.eventType??e.listEvent?.eventType??e.textEvent?.eventType??0;
    if(state.persistence==='loading'&&![4,5,6,7].includes(type))return;
    // 4 -> menu selection -> 5 is the OS contextual overlay, not app teardown.
    if(type===4){overlayPrompts=state.settings.savedPrompts;raise.reset();calibration?.cancel();contextualOpen=true;++renderSerial;glasses.invalidateRender();syncDisplayTimers();return;}
    if(type===5){overlayPrompts=undefined;contextualOpen=false;const action=pendingMenuAction;pendingMenuAction=undefined;syncDisplayTimers(true);if(active)fire(action?action():state.displaySleeping?restoreDisplay():render());return;}
    if(type===6||type===7){active=false;disposed=true;resetUsage();locationCache.configure();calibration?.cancel();fire(syncImu());replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();contextualOpen=false;pendingMenuAction=undefined;++actionSerial;clearTimeout(poll);syncDisplayTimers();foregroundAbort.abort();fire(stopRecording(true));fire(save());glasses.disconnect();return;}
    if(contextualOpen||!active)return;
    if([0,1,2,3,9,10].includes(type))syncDisplayTimers(true);
    if(state.displaySleeping){
      if(type===9){displayInteraction();fire(act(()=>startRecording('hold'),undefined,false));}
      else if([0,1,2,3].includes(type))fire(restoreDisplay());
      return;
    }
    if(type===9){if(!['settings','usage','space','space-list','space-control'].includes(screen))fire(act(()=>startRecording('hold'),undefined,false));return;}
    if(type===10){if(recordingMode==='hold')fire(act(()=>stopRecording(false),undefined,false));return;}
    if(type===3){
      if(state.recording||voiceBusy){fire(act(()=>stopRecording(true),undefined,false));return;}
      if(feedback){++actionSerial;const back=feedback.back;feedback=undefined;fire(act(back||render));return;}
      if(screen==='settings' && editingSetting)fire(act(showSettings));
      else if(screen==='space-control')fire(act(spaceBack));
      else if(screen==='space')fire(act(spaceLayout()==='list'?showSpaceItems:showSpaces));
      else if(screen==='space-list')fire(act(showSpaces));
      else if(screen==='home')fire(act(()=>glasses.exit(),undefined,false));else fire(act(showMenu));return;
    }
    if(type===0){
      if(state.recording){fire(act(()=>stopRecording(false),undefined,false));return;}if(voiceBusy)return;
      if(feedback){
        const pages=feedbackPages(),index=feedback.page||0;
        if(index<pages.length-1){feedback.page=index+1;fire(render());return;}
        if(feedback.kind==='busy')return;
        const retry=feedback.retry,back=feedback.back;feedback=undefined;fire(retry?retry():act(back||render));return;
      }
      if(e.listEvent){
        if(['home','settings','spaces','space-list','space-control'].includes(screen)){
          const action=menuActions[e.listEvent.currentSelectItemIndex??0];
          if(action)fire(act(action));
        }return;
      }
      if(screen==='space-control'&&spaceEditor){const {target,value}=spaceEditor;
        if((target.control.type==='button'||target.control.type==='slider')&&page<editorPages().length-1){page++;fire(act(render));return;}
        fire(act(()=>dispatchSpaceAction(spaceRequest(target,value)),undefined,false));return;}
      if(screen==='space'&&currentSpaceItem()?.control){
        if(page<controlPages(currentSpaceItem()!).length-1){page++;fire(act(render));return;}
        fire(act(()=>activateSpaceItem(spaceId,spaceItemId),undefined,false));return;
      }
      if(screen==='usage'){page=(page+1)%usagePages().length;fire(render());return;}
      if(screen==='message'||screen==='space'){page++;fire(act(render));}return;
    }
    if(type===1||type===2){if(state.recording||voiceBusy)return;
      if(feedback)return;
      if(screen==='usage'){page=Math.max(0,Math.min(usagePages().length-1,page+(type===1?-1:1)));fire(render());return;}
      if(screen==='space-control'&&spaceEditor?.target.control.type==='slider'){
        const c=spaceEditor.target.control;spaceEditor.value=sliderValue(c,Number(spaceEditor.value)+(type===1?c.step:-c.step));fire(act(render));return;
      }
      if(screen==='space'){const s=state.snapshot.spaces.find(s=>s.id===spaceId);if(s?.items.length){spaceItem=(spaceItem+(type===1?-1:1)+s.items.length)%s.items.length;spaceItemId=s.items[spaceItem]!.id;}page=0;fire(act(render));return;}
      if(['home','settings','spaces','space-list','space-control'].includes(screen))return;
      const all=visible(),options=chatOptions(),exchange=state.settings.chatLayout==='exchange'?currentExchange(all,state.selectedMessageId||''):undefined;
      const messages=(state.settings.chatLayout==='exchange'?chatEntries(all,options):all).reverse();
      const anchor=exchange?.reply?.id||exchange?.input.id||state.selectedMessageId,index=messages.findIndex(m=>m.id===anchor);
      const next=(index+(type===1?-1:1)+messages.length)%messages.length;
      if(messages[next])fire(act(()=>api.showMessage(messages[next]!.id)));
    }
  }
  const api:AppController={state, get hasChatLocation(){return !!locationCache.current();},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    saveSettings:settings=>guarded(()=>persistSettings(settings)),
    reloadSettings:()=>guarded(loadSettings),
    async checkConnection(settings=state.settings){return guarded(async()=>makeRelay(validateSettings({...settings,voice:'muse'})).read());},
    refresh:()=>guarded(()=>refresh(true)),
    sendSavedPrompt:slot=>guarded(()=>sendPreset(slot)),
    checkUsage,
    async sendText(value,image){await guarded(async()=>{const textValue=value.trim();if(!textValue&&!image)return;
      if(textValue.length>10000)throw new Error('Message too long');const req=request(textValue);if(image)req.image=image;await returnToSentChat(await send(req));});},
    toggleRecording:()=>guarded(()=>state.recording?stopRecording(false):startRecording()),
    cancelRecording:()=>guarded(()=>stopRecording(true)),
    async importMotion(kind,files){
      await motions.import(kind,files);motionChanged(kind);
    },
    useRelayMotion(kind){motions.useRelay(kind);syncMotions();motionChanged(kind);},
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
      if(followingChat&&ids.includes(followingChat.id))followingChat=undefined;
      if(state.selectedMessageId&&state.hiddenIds.includes(state.selectedMessageId)){
        followingChat=undefined;
        state.selectedMessageId=visible().at(-1)?.id;page=0;feedback=undefined;
      }
      emit();await save(true);await render();
    });},
    async restoreHiddenMessages(){await guarded(async()=>{if(!persistenceReady||state.persistence==='loading')return;state.hiddenIds=[];emit();await save(true);await render();});},
    hideMessage:id=>api.hideMessages([id]),
    async showSpace(id,itemId){await guarded(async()=>{const s=state.snapshot.spaces.find(s=>s.id===id);if(!s)return;
      if(state.recording||voiceBusy)return;
      displayInteraction();followingChat=undefined;
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
      displayInteraction();followingChat=undefined;
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
    try{await glasses.start();state.glasses=true;syncLocation();fire(syncImu());emit();await render();}
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
    if(nativeHost){fire(save());if(!document.hidden){syncLocation(true);fire(render());}return;}
    if(document.hidden){active=false;contextualOpen=false;pendingMenuAction=undefined;++actionSerial;++renderSerial;glasses.invalidateRender();clearTimeout(poll);syncDisplayTimers();foregroundAbort.abort();fire(stopRecording(true));fire(save());}
    else{active=true;contextualOpen=false;foregroundAbort=new AbortController();if(feedback?.kind==='busy')feedback=undefined;fire(render());armPoll(0);}
  });
  window.addEventListener('pagehide',()=>{active=false;disposed=true;resetUsage();locationCache.configure();calibration?.cancel();fire(syncImu());++renderSerial;glasses.invalidateRender();replyPoll.clear();awaitingReplies.clear();autoHiddenReplies.clear();++actionSerial;clearTimeout(poll);syncDisplayTimers();foregroundAbort.abort();fire(stopRecording(true));fire(save());});
  return api;
}
