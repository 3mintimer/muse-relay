import { AppLocationAccuracy, type AppLocation, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { ChatLocation, Settings } from './types';

const maxAgeMs = 5 * 60_000;
type LocationBridge = Pick<EvenAppBridge, 'startAppLocationUpdates' | 'stopAppLocationUpdates' | 'onAppLocationChanged' | 'getAppLocation'>;

/** Keep a verbatim echo of this turn's shared fix out of the phone and glasses reply. */
export function hideEchoedLocation(reply: string, fix: ChatLocation, label: string): string {
  const decimal = (value: number) => String(value).replace(/[.+]/g, '\\$&');
  const pair = new RegExp(`(^|[^\\d.+-])(?:(?:緯度|latitude)\\s*[:：]?\\s*)?${decimal(fix.latitude)}\\s*[,，、]\\s*(?:経度|longitude)?\\s*[:：]?\\s*${decimal(fix.longitude)}(?!\\d|\\.\\d)`, 'gi');
  return reply.replace(/(?:【現在地】\s*)?\{\s*"latitude"[^{}]*\}/gu, block => {
    try {
      const value = JSON.parse(block.slice(block.indexOf('{')));
      if (value.latitude === fix.latitude && value.longitude === fix.longitude) return label;
    } catch { /* Preserve ordinary reply text. */ }
    return block;
  }).replace(pair, (_, prefix: string) => prefix + label);
}

// Unsent fixes live only in this instance. Native location work never uses the glasses command queue.
export class ChatLocationCache {
  private bridge?: LocationBridge;
  private generation = 0;
  private intervalMinutes?: Settings['locationIntervalMinutes'];
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private changes = Promise.resolve();
  private fix?: ChatLocation;

  private readonly onFirstFix?: () => void;

  constructor(onFirstFix?: () => void) { this.onFirstFix = onFirstFix; }

  current(now = Date.now()): ChatLocation | undefined {
    if (this.fix) {
      const age = now - this.fix.captured_at * 1000;
      if (age >= 0 && age < maxAgeMs) return this.fix;
      this.fix = undefined;
    }
  }

  configure(bridge?: LocationBridge, minutes: Settings['locationIntervalMinutes'] = 1, restart = false) {
    if (this.bridge === bridge && (!bridge || this.intervalMinutes === minutes) && !restart) return;
    const intervalMs = minutes * 60_000;
    this.intervalMinutes = minutes;
    const previous = this.bridge;
    this.bridge = bridge;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!bridge || bridge !== previous) this.fix = undefined;

    const accept = (location: AppLocation | null) => {
      if (!location || generation !== this.generation) return;
      const { latitude, longitude, accuracy } = location;
      const now = Date.now();
      const timestamp = location.timestamp ?? now;
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180
        || !Number.isFinite(timestamp) || timestamp > now || now - timestamp >= maxAgeMs) return;
      const captured_at = Math.floor(timestamp / 1000);
      const previousFix = this.current(now);
      if (previousFix && captured_at < previousFix.captured_at) return;
      this.fix = { latitude, longitude, captured_at, ...(typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}) };
      if (!previousFix) this.onFirstFix?.();
    };

    // Serialize native start/stop across fast toggles. Invalidate callbacks immediately on opt-out.
    this.changes = this.changes.then(async () => {
      if (previous) await previous.stopAppLocationUpdates().catch(() => false);
      if (!bridge || generation !== this.generation) return;
      this.unsubscribe = bridge.onAppLocationChanged(accept);
      await bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.Medium, intervalMs, distanceFilter: 0 });
    }).catch(() => { /* A host may offer only one-shot fixes. */ });
    if (!bridge) return;
    let pending = false;
    const prefetch = async () => {
      if (generation !== this.generation) return;
      this.timer = setTimeout(prefetch, intervalMs);
      const latest = this.current();
      if (pending || (latest && Date.now() - latest.captured_at * 1000 < intervalMs)) return;
      pending = true;
      try {
        accept(await bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 5000 }));
      } catch { /* Chat can always send without a fix. */ }
      finally { pending = false; }
    };
    void prefetch();
  }
}
