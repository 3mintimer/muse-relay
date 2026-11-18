import { defaults, validateSettings } from './config';
import { parseSnapshot } from '../relay/protocol';
import type { Settings, Snapshot } from './types';

export const LOCAL_STATE_KEY = 'muse-relay-state-v1';
const LOCAL_CACHE_KEY = 'muse-relay-cache-v1';
export type StorageMode = 'native' | 'local' | 'unavailable';
export interface SavedState {
  settings: Settings;
  snapshot: Snapshot;
  readIds: string[];
  hiddenIds: string[];
  selectedSpaceIds: string[];
  savedAt?: number;
}
export interface NativeStorage { load(): Promise<string>; save(value: string): Promise<void>; }
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A damaged message cache must not discard otherwise valid connection settings. */
export function decodeSavedState(raw: string): SavedState | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw);
    if (!value?.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) return;
    const settings = validateSettings({ ...defaults, ...value.settings }, false);
    if (settings.configured) {
      try { Object.assign(settings, validateSettings(settings)); }
      catch { settings.configured = false; } // Keep entered values available for repair.
    }
    let snapshot: Snapshot = { messages: [], spaces: [] };
    try { if (value.snapshot) snapshot = parseSnapshot(value.snapshot); } catch { /* Cache is optional. */ }
    const ids = (key: string, limit: number) => Array.isArray(value[key]) ? value[key].filter((id: unknown) => typeof id === 'string').slice(-limit) : [];
    return { settings, snapshot, readIds: ids('readIds', 300), hiddenIds: ids('hiddenIds', 300), selectedSpaceIds: [...new Set(ids('selectedSpaceIds', 15))],
      savedAt: Number.isSafeInteger(value.savedAt) && value.savedAt > 0 ? value.savedAt : 0 };
  } catch { return; }
}

/** Host storage and the local backup contain the same app-owned record. No G2 calls. */
export class StateStorage {
  private generation = 0;
  private savedAt = 0;
  private writable = false;
  private nativeRead = false;
  private local: LocalStorage;
  private native?: NativeStorage;
  private now: () => number;
  constructor(local: LocalStorage, native?: NativeStorage, now = Date.now) { this.local = local; this.native = native; this.now = now; }
  useNative(native: NativeStorage): void { ++this.generation; this.native = native; this.nativeRead = false; }

  async load(): Promise<{ value?: SavedState; mode: StorageMode; failed: boolean; stale: boolean; writable: boolean }> {
    const generation = this.generation;
    let localRaw = '', nativeRaw = '', localRead = false, nativeRead = !this.native;
    try { localRaw = this.local.getItem(LOCAL_STATE_KEY) || ''; localRead = true; } catch { /* Storage may be disabled. */ }
    if (this.native) {
      try { nativeRaw = await this.native.load(); nativeRead = true; } catch { /* Try the durable local backup. */ }
    }
    if (generation !== this.generation) return { mode: 'unavailable', failed: false, stale: true, writable: this.writable };
    // Another foreground/headless view may have saved while the native read waited.
    try { localRaw = this.local.getItem(LOCAL_STATE_KEY) || localRaw; } catch { /* Retain the earlier read. */ }
    const local = decodeSavedState(localRaw), native = decodeSavedState(nativeRaw);
    const useLocal = Boolean(local && (!native || (local.savedAt || 0) > (native.savedAt || 0)));
    let value = useLocal ? local : native || local;
    this.nativeRead = nativeRead && (!nativeRaw || Boolean(native));
    this.writable = Boolean(value) || (this.native ? this.nativeRead && !nativeRaw : localRead && !localRaw);
    this.savedAt = value?.savedAt || 0;
    if (value) {
      try {
        const cache = JSON.parse(this.local.getItem(LOCAL_CACHE_KEY) || 'null');
        if (cache?.savedAt === this.savedAt) value = decodeSavedState(JSON.stringify({ ...value, snapshot: cache.snapshot,
          readIds: cache.readIds, hiddenIds: cache.hiddenIds, selectedSpaceIds: value.selectedSpaceIds })) || value;
      } catch { /* A local message cache is optional. */ }
    }
    if (value) { try { this.local.setItem(LOCAL_STATE_KEY, JSON.stringify({ ...value, snapshot: { messages: [], spaces: [] } })); } catch { /* Native can remain the primary store. */ } }
    const mode: StorageMode = value ? useLocal || !this.native ? 'local' : 'native'
      : this.writable ? this.native ? 'native' : 'local' : 'unavailable';
    return { value, mode, writable: this.writable, stale: false,
      failed: Boolean(this.native && !this.nativeRead) || Boolean(localRaw && !local && !native) };
  }

  async save(value: SavedState, explicit = false): Promise<StorageMode | null> {
    if (!explicit) {
      if (!this.writable) return null;
      // Polling / closing a WebView must never rewrite connection credentials.
      try { this.local.setItem(LOCAL_CACHE_KEY, JSON.stringify({ savedAt: this.savedAt, snapshot: value.snapshot, readIds: value.readIds, hiddenIds: value.hiddenIds })); } catch { /* Optional cache. */ }
      return null;
    }
    ++this.generation; // A late read can never replace a user save or credential removal.
    this.savedAt = Math.max(this.now(), this.savedAt + 1);
    const raw = JSON.stringify({ ...value, snapshot: { messages: [], spaces: [] }, savedAt: this.savedAt });
    let localSaved = false, nativeSaved = false;
    try { this.local.setItem(LOCAL_STATE_KEY, raw); localSaved = true; } catch { /* Try native storage. */ }
    try { this.local.setItem(LOCAL_CACHE_KEY, JSON.stringify({ savedAt: this.savedAt, snapshot: value.snapshot, readIds: value.readIds, hiddenIds: value.hiddenIds })); } catch { /* Cache size cannot make a settings save fail. */ }
    if (this.native) {
      try { await this.native.save(raw); nativeSaved = true; this.nativeRead = true; } catch { /* Report the backup-only result. */ }
    }
    if (!localSaved && !nativeSaved) throw new Error('Settings save failed');
    this.writable = true;
    return nativeSaved ? 'native' : 'local';
  }
}
