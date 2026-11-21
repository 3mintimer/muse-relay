export type RelayMode = 'gist' | 'gadget' | 'custom';
export type Theme = 'system' | 'light' | 'dark';
export type Locale = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'es' | 'fr' | 'de' | 'it' | 'ko';
export type Language = 'system' | Locale;
export type VoiceMode = 'muse' | 'soniox';
export interface Settings {
  relay: RelayMode;
  gistId: string;
  githubToken: string;
  relayUrl: string;
  relayToken: string;
  gatewayToken: string;
  customRelayUrl: string;
  customRelayToken: string;
  customGatewayToken: string;
  sonioxAuth: 'auto' | 'api-key' | 'token-server';
  sonioxApiKey: string;
  sonioxTokenUrl: string;
  sonioxTokenAuth: string;
  sonioxGatewayToken: string;
  voice: VoiceMode;
  mic: 'glasses' | 'phone';
  speakerFilter: 'all' | 'self' | 'other';
  theme: Theme;
  language: Language;
  pollSeconds: number;
  autoHideSeconds: number;
  headWake: boolean;
  headWakeMic: boolean;
  headWakeAngle: number;
  neutralPitch: number;
  returnToChatAfterSend: boolean;
  chatLayout: 'exchange' | 'single';
  shareLocation: boolean;
  locationIntervalMinutes: 1 | 3 | 5;
  images: boolean;
  homeAvatar: 'animation' | 'still' | 'off';
  waitingAvatar: 'animation' | 'off';
  configured: boolean;
}
export interface Attachment {
  mime: string;
  data_base64: string;
  name: string;
}
export interface Message {
  id: string;
  from: string;
  type: 'text' | 'voice-note' | 'image';
  text: string;
  ts: number;
  audio_file?: string;
  image_file?: string;
  mime_type?: string;
  reply_to?: string;
  image?: Attachment;
}
export type SpaceControl =
  | {type:'button';label?:string;confirm?:string;disabled?:boolean}
  | {type:'slider';min:number;max:number;step:number;value:number;unit?:string;disabled?:boolean}
  | {type:'choice';options:{id:string;title:string}[];value?:string;disabled?:boolean}
  | {type:'microphone';disabled?:boolean}
  | {type:'unsupported';disabled:true};
export interface SpaceAction {item_id:string;type:'button'|'slider'|'choice'|'microphone';value?:number|string}
export interface SpaceItem { id: string; title: string; text: string; ts?: number; image_file?: string; image?: Attachment; control?:SpaceControl; }
export interface Space { id: string; title: string; layout?:'list'|'cards'; updated_at?: number; items: SpaceItem[]; }
export const MOTION_SPACE_ID = 'muse_relay_avatar_motion_v1';
export const motionKinds = ['idle', 'working'] as const;
export type MotionKind = typeof motionKinds[number];
export interface MotionSource { file?:string; image?:Attachment; revision?:number }
export interface MotionState { frames?:Uint8Array[]; sheet?:Attachment; status:'none'|'loading'|'ready'|'error'; local:boolean }
export interface MuseProfile { name?:string; avatar?:Attachment; avatar_file?:string; mime_type?:string; updated_at?:number; }
export interface Snapshot {
  messages: Message[];
  spaces: Space[];
  profile?: MuseProfile;
  motions?: Partial<Record<MotionKind, MotionSource>>;
  device?: { connected: boolean; last_seen?: number };
  capabilities?: { audio: boolean; images: boolean; spaces: boolean; soniox?: boolean; live_transcription?: boolean };
}
export interface ChatLocation { latitude: number; longitude: number; captured_at: number; accuracy?: number }
export interface RelayRequest {
  location?: ChatLocation;
  id: string;
  kind: 'chat' | 'space';
  text: string;
  created_at: number;
  space_id?: string;
  space_action?: SpaceAction;
  audio?: Attachment;
  image?: Attachment;
}
export interface Relay {
  read(signal?: AbortSignal): Promise<Snapshot>;
  send(request: RelayRequest, signal?: AbortSignal): Promise<void>;
  attachment(file: string, mime: string, signal?: AbortSignal): Promise<Attachment>;
}
export interface AppState {
  persistence: 'loading' | 'native' | 'local' | 'unavailable';
  settingsLoadFailed: boolean;
  settings: Settings;
  snapshot: Snapshot;
  connected: boolean;
  glasses: boolean;
  displaySleeping: boolean;
  busy: boolean;
  recording: boolean;
  transcript: string;
  error: string;
  notice: string;
  lastSync?: number;
  readIds: string[];
  hiddenIds: string[];
  selectedSpaceIds: string[];
  motions: Record<MotionKind, MotionState>;
  avatarStatus?: 'none'|'loading'|'ready'|'error';
  selectedMessageId?: string;
  spaceAction?: {spaceId:string;itemId:string;status:'sending'|'sent'|'error'|'recording';message:string};
}
export interface AppController {
  readonly hasChatLocation: boolean;
  state: AppState;
  subscribe(listener: () => void): () => void;
  saveSettings(settings: Settings): Promise<void>;
  importMotion(kind:MotionKind, files:File[]):Promise<void>;
  useRelayMotion(kind:MotionKind):void;
  reloadSettings(): Promise<void>;
  checkConnection(settings?: Settings): Promise<Snapshot>;
  refresh(): Promise<void>;
  sendText(text: string, image?: Attachment): Promise<void>;
  toggleRecording(): Promise<void>;
  cancelRecording(): Promise<void>;
  pickImage(source: 'album' | 'camera'): Promise<Attachment | null>;
  showMessage(id: string): Promise<void>;
  loadMessageImage(id: string): Promise<void>;
  markRead(ids: string[]): Promise<void>;
  hideMessages(ids: string[]): Promise<void>;
  restoreHiddenMessages(): Promise<void>;
  hideMessage(id: string): Promise<void>;
  showSpace(id: string, itemId?: string): Promise<void>;
  selectSpaces(ids: string[]): Promise<void>;
  requestSpace(id: string): Promise<void>;
  activateSpaceItem(spaceId:string,itemId:string):Promise<void>;
  submitSpaceAction(spaceId:string,itemId:string,value?:number|string):Promise<void>;
  showGlassesMenu(): Promise<void>;
  measureNeutralPitch(): Promise<number>;
  restoreDisplay(): Promise<void>;
  clearCredentials(): Promise<void>;
}
