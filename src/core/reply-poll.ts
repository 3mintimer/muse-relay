import type { Message } from './types';

const FAST_MS = 1000;
const QUIET_MS = 5000;
const MAX_WAIT_MS = 120000;

// Temporary receive cadence only. Nothing here changes saved settings or resends a request.
export class ReplyPoll {
  private pending = new Map<string, { deadline: number; content?: string; changedAt?: number }>();

  sent(id: string, now = Date.now()) {
    this.pending.set(id, { deadline: now + MAX_WAIT_MS });
  }

  observe(messages: Message[], now = Date.now()) {
    for (const [id, wait] of this.pending) {
      const replies = messages.filter(message => message.reply_to === id && message.from !== 'You')
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!replies.length) continue;
      // A first partial reply is not completion. Keep following changes until it goes quiet.
      const content = JSON.stringify(replies.map(m => [m.id, m.type, m.text, m.image_file, m.audio_file, m.ts]));
      if (wait.content !== content) { wait.content = content; wait.changedAt = now; }
    }
  }

  delay(normalMs: number, now = Date.now()): number {
    for (const [id, wait] of this.pending) {
      if (now >= wait.deadline || (wait.changedAt !== undefined && now - wait.changedAt >= QUIET_MS)) this.pending.delete(id);
    }
    return this.pending.size ? Math.min(normalMs, FAST_MS) : normalMs;
  }

  clear() { this.pending.clear(); }
}
