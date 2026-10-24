type Window = { count: number; resetAt: number };

export type Limit = { max: number; windowMs: number };

export const LOGIN_PER_ACCOUNT: Limit = { max: 10, windowMs: 15 * 60 * 1000 };
export const LOGIN_PER_IP: Limit = { max: 30, windowMs: 15 * 60 * 1000 };
export const REGISTER_PER_IP: Limit = { max: 10, windowMs: 60 * 60 * 1000 };

const windows = new Map<string, Window>();

// Seconds until `key` may try again, or 0 when it is under its limit.
export function retryAfter(key: string, limit: Limit): number {
  const window = windows.get(key);
  if (!window || window.resetAt <= Date.now()) return 0;
  return window.count >= limit.max ? Math.ceil((window.resetAt - Date.now()) / 1000) : 0;
}

export function record(key: string, limit: Limit): void {
  const now = Date.now();
  if (windows.size > 10_000) sweep(now);
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return;
  }
  window.count += 1;
}

export function reset(key: string): void {
  windows.delete(key);
}

function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}
