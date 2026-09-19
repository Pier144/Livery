import { call, isTauri } from '@/lib/tauri';

let reported = false;

/**
 * Tells the backend the first screen is on screen (`app_ready`), once per launch. The backend
 * answers the milliseconds since it started and logs them the first time ("startup: first
 * screen after N ms"); in dev they also go to the console. A no-op outside Tauri (browser, mock
 * backend, tests); errors are swallowed, since this is only a measurement.
 */
export async function reportReady(): Promise<number | undefined> {
  if (reported || !isTauri()) return undefined;
  reported = true;
  try {
    const ms = await call<number>('app_ready');
    if (import.meta.env.DEV) console.info(`[livery] first screen after ${ms} ms`);
    return ms;
  } catch {
    return undefined;
  }
}

/**
 * {@link reportReady} after two animation frames: the first runs before the next paint, the
 * second after it, so the time covers a painted screen, not just a committed one.
 */
export function reportReadyAfterPaint(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void reportReady();
    });
  });
}

/** Tests only: lets {@link reportReady} report again. */
export function resetStartupReport(): void {
  reported = false;
}
