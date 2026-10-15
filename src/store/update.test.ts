import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdate } from './update';

const backend = vi.hoisted(() => ({ call: vi.fn<(cmd: string) => Promise<unknown>>() }));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  call: (cmd: string) => backend.call(cmd),
}));

const state = () => useUpdate.getState();

describe('update store', () => {
  beforeEach(() => {
    state().reset();
    backend.call.mockReset();
  });

  it('maps the check to up to date, available or ready', async () => {
    backend.call.mockResolvedValueOnce({ current: '0.1.0', ready: false });
    await state().check();
    expect(state().phase).toBe('upToDate');
    backend.call.mockResolvedValueOnce({ current: '0.1.0', latest: '0.2.0', ready: false });
    await state().check();
    expect(state()).toMatchObject({ phase: 'available', latest: '0.2.0' });
    backend.call.mockResolvedValueOnce({ current: '0.1.0', latest: '0.2.0', ready: true });
    await state().check();
    expect(state().phase).toBe('ready');
  });

  it('a background download that starts during a check keeps its phase', async () => {
    let answer!: (v: unknown) => void;
    backend.call.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const checking = state().check();
    state().progress({ downloaded: 1, total: 4 });
    answer({ current: '0.1.0', latest: '0.2.0', ready: false });
    await checking;
    expect(state()).toMatchObject({ phase: 'downloading', pct: 25 });
  });

  it('a failed install shows the error and can be tried again', async () => {
    backend.call.mockResolvedValueOnce({ current: '0.1.0', latest: '0.2.0', ready: false });
    await state().check();
    backend.call.mockRejectedValueOnce({ code: 'network', message: "The update couldn't be downloaded" });
    await state().install();
    expect(state()).toMatchObject({ phase: 'error', requested: false, latest: '0.2.0' });
    expect(state().error?.code).toBe('network');
  });

  it('only a requested download ends in installing; a background one waits for ready', () => {
    state().progress({ downloaded: 10, total: 10 });
    expect(state().phase).toBe('downloading');
    state().ready('0.2.0');
    expect(state()).toMatchObject({ phase: 'ready', latest: '0.2.0' });
  });
});
