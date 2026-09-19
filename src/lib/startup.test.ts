import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportReady, reportReadyAfterPaint, resetStartupReport } from './startup';

const tauri = vi.hoisted(() => ({
  enabled: true,
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => tauri.enabled,
  hasBackend: () => tauri.enabled,
  call: (cmd: string, args?: Record<string, unknown>) => tauri.call(cmd, args),
}));

describe('reportReady', () => {
  beforeEach(() => {
    resetStartupReport();
    tauri.enabled = true;
    tauri.call.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('asks the backend once and returns the milliseconds', async () => {
    tauri.call.mockResolvedValue(412);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(reportReady()).resolves.toBe(412);
    await expect(reportReady()).resolves.toBeUndefined();
    expect(tauri.call).toHaveBeenCalledTimes(1);
    expect(tauri.call).toHaveBeenCalledWith('app_ready', undefined);
    // Vitest runs in dev mode: the time goes to the console too.
    expect(info).toHaveBeenCalledWith('[livery] first screen after 412 ms');
  });

  it('does nothing outside Tauri', async () => {
    tauri.enabled = false;
    await expect(reportReady()).resolves.toBeUndefined();
    expect(tauri.call).not.toHaveBeenCalled();
  });

  it('swallows backend errors and does not retry', async () => {
    tauri.call.mockRejectedValue({ code: 'internal', message: 'nope' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(reportReady()).resolves.toBeUndefined();
    await expect(reportReady()).resolves.toBeUndefined();
    expect(tauri.call).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('waits two animation frames before reporting', async () => {
    tauri.call.mockResolvedValue(90);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    reportReadyAfterPaint();
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(tauri.call).not.toHaveBeenCalled();
    expect(frames).toHaveLength(2);
    frames[1]?.(16);
    expect(tauri.call).toHaveBeenCalledWith('app_ready', undefined);
  });
});
