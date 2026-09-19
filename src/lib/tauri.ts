import { invoke, isTauri as coreIsTauri } from '@tauri-apps/api/core';
import type { AppError } from '@/types';

/** True inside the Tauri webview; false in `pnpm dev` in a plain browser and under Vitest. */
export function isTauri(): boolean {
  try {
    return coreIsTauri();
  } catch {
    return false;
  }
}

function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

/** Normalizes anything thrown by `invoke` into the `{ code, message, detail? }` shape. */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) return { code: 'internal', message: e.message };
  return { code: 'internal', message: String(e) };
}

/** Typed `invoke` that always rejects with an `AppError`. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw { code: 'noBackend', message: `"${cmd}" needs the desktop app` } satisfies AppError;
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

/** Window controls for the frameless title bar. No-ops outside Tauri. */
export const appWindow = {
  async minimize() {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  },
  async toggleMaximize() {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  },
  async close() {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  },
  async isMaximized(): Promise<boolean> {
    if (!isTauri()) return false;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().isMaximized();
  },
  /** Subscribes to resize (maximize/restore); returns an unsubscribe function. */
  async onResized(cb: () => void): Promise<() => void> {
    if (!isTauri()) return () => {};
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().onResized(cb);
  },
};
