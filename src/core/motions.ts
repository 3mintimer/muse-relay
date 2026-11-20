import { importMotionSheet, motionFrames } from './media';
import { motionKinds, type AppState, type Attachment, type MotionKind, type MotionSource, type MotionState, type Settings } from './types';

/** The phone describes the same available artwork that the glasses renderer uses. */
export function avatarDisplay(state: AppState, kind: MotionKind): Settings['homeAvatar'] {
  const preference = kind === 'idle' ? state.settings.homeAvatar : state.settings.waitingAvatar;
  if (!state.settings.images || preference === 'off') return 'off';
  if (preference === 'animation' && state.motions[kind].frames?.length) return 'animation';
  if (kind === 'idle' && state.avatarStatus !== 'error' && state.snapshot.profile?.avatar) return 'still';
  return 'off';
}

interface Slot {
  key?: string;
  retryAt: number;
  manual?: Attachment;
  generation: number;
}

export class AvatarMotions {
  readonly state: Record<MotionKind, MotionState> = {
    idle: { status: 'none', local: false },
    working: { status: 'none', local: false },
  };
  private slots: Record<MotionKind, Slot> = {
    idle: { retryAt: 0, generation: 0 },
    working: { retryAt: 0, generation: 0 },
  };
  private scope = '';

  private storageKey(kind: MotionKind) {
    return 'muse-relay-motion-v1:' + this.scope + ':' + kind;
  }

  restore(connection: string) {
    // FNV-1a namespaces device artwork without storing an endpoint in the key.
    // Settings restoration also runs in WebViews without Web Crypto.
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(connection)) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    this.scope = hash.toString(16);
    for (const kind of motionKinds) {
      const slot = this.slots[kind];
      ++slot.generation;
      slot.key = undefined;
      slot.manual = undefined;
      slot.retryAt = 0;
      this.state[kind] = { status: 'none', local: false };
      try {
        const data = localStorage.getItem(this.storageKey(kind));
        if (data) slot.manual = { mime: 'image/png', name: 'motion.png', data_base64: data };
      } catch { /* Relay assets remain usable without WebView storage. */ }
    }
  }

  async import(kind: MotionKind, files: File[]) {
    const scope = this.scope;
    const sheet = await importMotionSheet(files);
    const frames = await motionFrames(sheet, true);
    if (scope !== this.scope) throw new Error('Connection changed');
    localStorage.setItem(this.storageKey(kind), sheet.data_base64);
    const slot = this.slots[kind];
    ++slot.generation;
    slot.manual = sheet;
    slot.key = sheet.data_base64;
    this.state[kind] = { status: 'ready', local: true, frames, sheet };
  }

  useRelay(kind: MotionKind) {
    localStorage.removeItem(this.storageKey(kind));
    const slot = this.slots[kind];
    ++slot.generation;
    slot.manual = undefined;
    slot.key = undefined;
    this.state[kind] = { status: 'none', local: false };
  }

  playbackFailed(kind: MotionKind, frames: Uint8Array[]) {
    if (this.state[kind].frames !== frames) return;
    this.slots[kind].retryAt = Date.now() + 30000;
    this.state[kind] = { status: 'error', local: !!this.slots[kind].manual };
  }

  async sync(kind: MotionKind, source: MotionSource | undefined, enabled: boolean,
    download: (file: string) => Promise<Attachment>, changed: () => void, retry: boolean) {
    const slot = this.slots[kind];
    const asset = slot.manual ?? source?.image;
    const fileKey = source?.file && JSON.stringify([source.file, source.revision]);
    const key = enabled ? asset?.data_base64 || fileKey : undefined;
    const retryDue = this.state[kind].status === 'error' && (retry || Date.now() >= slot.retryAt);
    if (slot.key === key && !retryDue) return;

    slot.key = key;
    const generation = ++slot.generation;
    const local = !!slot.manual;
    this.state[kind] = { status: key ? 'loading' : 'none', local };
    changed();
    if (!key) return;
    try {
      const sheet = asset ?? await download(source!.file!);
      if (generation !== slot.generation) return;
      const frames = await motionFrames(sheet, local);
      if (generation !== slot.generation) return;
      this.state[kind] = { status: 'ready', frames, sheet, local };
    } catch {
      if (generation !== slot.generation) return;
      slot.retryAt = Date.now() + 30000;
      this.state[kind] = { status: 'error', local };
    }
    changed();
  }
}
