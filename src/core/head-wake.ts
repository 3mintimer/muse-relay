// G2 gravity coordinates follow Neck Lift: positive X pitches the glasses upwards.
export function headPitch(gravity: {x?: number; y?: number; z?: number}): number | undefined {
  const {x = 0, y = 0, z = 0} = gravity;
  if (![x, y, z].every(Number.isFinite) || !Math.hypot(x, y, z)) return undefined;
  return Math.atan2(x, Math.hypot(y, z)) * 180 / Math.PI;
}

export class HeadRaise {
  private armed = false;
  private since?: number;
  private last?: number;

  reset() { this.armed = false; this.since = this.last = undefined; }

  sample(angle: number, threshold: number, now: number): boolean {
    if (this.last !== undefined && now - this.last > 600) this.reset();
    this.last = now;
    if (angle <= threshold - 5) this.armed = true;
    if (!this.armed || angle < threshold) { this.since = undefined; return false; }
    this.since ??= now;
    if (now - this.since < 200) return false;
    this.armed = false;
    this.since = undefined;
    return true;
  }
}
