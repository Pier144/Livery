import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/queries/client';
import { HANGAR_KEY } from '@/queries/hangar';
import { useQueue } from '@/store/queue';
import { useToasts } from '@/store/toasts';
import { renderWithProviders, resetStores } from '@/test/render';
import { EVENTS, type InstallProgress, type QueueItem } from '@/types';
import { useInstallEvents } from './useInstallEvents';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
  unlisten: vi.fn(),
  /** Replaced to hold listener registration open (unmount-before-resolve). */
  register: undefined as (() => Promise<() => void>) | undefined,
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@/lib/events', () => ({
  listenEvent: (name: string, handler: (payload: unknown) => void) => {
    backend.listeners.set(name, handler);
    return backend.register ? backend.register() : Promise.resolve(backend.unlisten);
  },
}));

const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  path: `C:\\Downloads\\${id}.zip`,
  fileName: `${id}.zip`,
  sizeBytes: 1,
  status: 'ready',
  ...extra,
});

/** Frames run only when the test says so. */
let frames: FrameRequestCallback[];
const runFrame = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb(0));
  });

const emit = (name: string, payload: unknown) => act(() => backend.listeners.get(name)?.(payload));
const tick = (queueId: string, step: InstallProgress['step'], pct: number, extra: Partial<InstallProgress> = {}) =>
  emit(EVENTS.installProgress, { installId: `i-${queueId}`, queueId, step, pct, ...extra });

function Harness() {
  useInstallEvents();
  return null;
}

let backendQueue: QueueItem[];

function renderHook() {
  const client = createQueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { ...renderWithProviders(<Harness />, { client }), invalidate };
}

beforeEach(() => {
  resetStores();
  useQueue.setState({ installs: {}, picked: {}, batchRunning: false });
  backend.call.mockReset();
  backend.listeners.clear();
  backend.unlisten.mockReset();
  backend.register = undefined;
  backendQueue = [];
  backend.call.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_queue') return backendQueue;
    throw { code: 'noBackend', message: `unexpected ${cmd}` };
  });
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useInstallEvents', () => {
  it('applies progress once per frame, keeping only the latest tick of each install', async () => {
    useQueue.setState({ items: [item('q1', { status: 'installing' })], installs: { q1: { step: 'extract', pct: 0 } } });
    renderHook();
    await waitFor(() => expect(backend.listeners.size).toBe(3));

    const apply = vi.spyOn(useQueue.getState(), 'applyProgress');
    tick('q1', 'extract', 10);
    tick('q1', 'extract', 20);
    tick('q1', 'verify', 70);
    expect(useQueue.getState().installs.q1).toMatchObject({ pct: 0 });
    expect(frames).toHaveLength(1);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(useQueue.getState().installs.q1).toMatchObject({ step: 'verify', pct: 70 });
  });

  it('still applies events when no frame comes (hidden or minimized window)', async () => {
    useQueue.setState({ items: [item('q1', { status: 'installing' })], installs: { q1: { step: 'extract', pct: 0 } } });
    renderHook();
    await waitFor(() => expect(backend.listeners.size).toBe(3));
    tick('q1', 'done', 100);
    expect(useQueue.getState().items[0]!.status).toBe('installing');
    // Frames are never run here: the timer fallback flushes.
    await waitFor(() => expect(useQueue.getState().items[0]!.status).toBe('done'));
    // The late frame is a no-op.
    runFrame();
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it('never merges a tick in front of the terminal event, and applies done in order', async () => {
    useQueue.setState({ items: [item('q1', { status: 'installing' })], installs: { q1: { step: 'extract', pct: 0 } } });
    const { invalidate } = renderHook();
    await waitFor(() => expect(backend.listeners.size).toBe(3));

    tick('q1', 'extract', 50);
    tick('q1', 'done', 100, { skinId: 's1' });
    tick('q1', 'extract', 99); // stray late tick
    runFrame();
    expect(useQueue.getState().items[0]).toMatchObject({ status: 'done' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: HANGAR_KEY });
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Installed “q1”']);
  });

  it('adds the watcher’s items, shows installs it didn’t start, and refetches the hangar on changes', async () => {
    const { invalidate } = renderHook();
    await waitFor(() => expect(backend.listeners.size).toBe(3));

    emit(EVENTS.queueAdded, item('w1', { fileName: 'watched.zip' }));
    runFrame();
    expect(useQueue.getState().items.map((i) => i.fileName)).toEqual(['watched.zip']);

    // The backend auto-installs it: the row follows even though the UI didn't start it.
    tick('w1', 'extract', 30);
    runFrame();
    expect(useQueue.getState().items[0]!.status).toBe('installing');
    expect(useQueue.getState().installs.w1).toMatchObject({ installId: 'i-w1', pct: 30 });

    // A change on disk rescans (the index follows the disk) and then refetches My Hangar.
    invalidate.mockClear();
    emit(EVENTS.hangarChanged, null);
    expect(backend.call).toHaveBeenCalledWith('scan_user_skins', undefined);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: HANGAR_KEY }));
  });

  it('loads what the backend already queued', async () => {
    backendQueue = [item('b1'), item('b2', { status: 'conflict' })];
    useQueue.setState({ items: [item('b1', { status: 'installing' })] });
    renderHook();
    await waitFor(() => expect(useQueue.getState().items.map((i) => i.id)).toEqual(['b1', 'b2']));
    // Known items keep their live state.
    expect(useQueue.getState().items[0]!.status).toBe('installing');
  });

  it('unsubscribes on unmount, also when registration resolves late', async () => {
    const { unmount } = renderHook();
    await waitFor(() => expect(backend.listeners.size).toBe(3));
    unmount();
    await waitFor(() => expect(backend.unlisten).toHaveBeenCalledTimes(3));

    const resolvers: Array<(fn: () => void) => void> = [];
    backend.register = () => new Promise((r) => resolvers.push(r));
    backend.unlisten.mockReset();
    const second = renderHook();
    await waitFor(() => expect(resolvers).toHaveLength(3));
    second.unmount();
    expect(backend.unlisten).not.toHaveBeenCalled();
    resolvers.forEach((r) => r(backend.unlisten));
    await waitFor(() => expect(backend.unlisten).toHaveBeenCalledTimes(3));
  });
});
