/**
 * Client for the desktop development bridge served by the Vite dev server
 * (see vite-dev-bridge.ts). Only active when the dev server was started with
 * `npm run dev:bridge`, which sets VITE_ZINIA_DEV_BRIDGE=1. Production builds
 * replace import.meta.env.DEV with false, so none of this ships in the app.
 */

const BASE = '/__zinia_dev/';

export class DevBridgeError extends Error {
  code?: string;
  data?: Record<string, unknown>;
  constructor(message: string, code?: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export async function devPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Zinia-Dev': '1' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as { ok: boolean; result?: T; error?: { message: string; code?: string; data?: Record<string, unknown> } };
  if (!payload.ok) {
    throw new DevBridgeError(payload.error?.message ?? 'Dev bridge error', payload.error?.code, payload.error?.data);
  }
  return payload.result as T;
}

let source: EventSource | null = null;
const handlers = new Set<(name: string, data: Record<string, unknown>) => void>();

export function devEvents(handler: (name: string, data: Record<string, unknown>) => void): void {
  handlers.add(handler);
  if (source) return;
  source = new EventSource(BASE + 'events');
  source.onmessage = (message) => {
    const event = JSON.parse(message.data as string) as { name: string; data: Record<string, unknown> };
    for (const h of handlers) h(event.name, event.data);
  };
}
