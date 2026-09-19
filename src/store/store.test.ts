import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from '@/test/render';
import { selectPendingCount, useQueue } from './queue';
import { TOAST_DURATION_MS, toast, useToasts } from './toasts';
import { useUi } from './ui';

beforeEach(() => resetStores());

describe('ui store', () => {
  it('navigating closes the palette', () => {
    useUi.getState().openPalette();
    useUi.getState().go('hangar');
    expect(useUi.getState().screen).toBe('hangar');
    expect(useUi.getState().palette.open).toBe(false);
  });

  it('palette opens clean and resets the index when the query changes', () => {
    const ui = useUi.getState();
    ui.openPalette();
    ui.setPaletteIndex(3);
    ui.setPaletteQuery('leo');
    expect(useUi.getState().palette).toEqual({ open: true, query: 'leo', index: 0 });
    ui.togglePalette();
    expect(useUi.getState().palette).toEqual({ open: false, query: '', index: 0 });
  });

  it('persists only the sidebar preference', () => {
    useUi.getState().toggleSidebar();
    useUi.getState().go('queue');
    const saved = JSON.parse(localStorage.getItem('livery.ui') ?? '{}');
    expect(saved.state).toEqual({ sidebarOpen: false });
  });
});

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expire after 6 s', () => {
    toast('Installed “Desert Storm Tan”');
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('undo runs the callback once and dismisses', async () => {
    const restore = vi.fn();
    const id = toast.undoable('Deleted 3 skins', restore);
    await useToasts.getState().undo(id);
    await useToasts.getState().undo(id);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('keeps at most four, dropping the oldest', () => {
    for (let i = 1; i <= 6; i++) toast(`t${i}`);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['t3', 't4', 't5', 't6']);
  });
});

describe('queue store', () => {
  it('accepts only zip/rar/7z and adds them as analyzing, newest first', () => {
    const q = useQueue.getState();
    q.addPaths(['C:\\Downloads\\a.zip']);
    const added = q.addPaths(['C:\\Downloads\\b.RAR', 'C:\\Downloads\\notes.txt', '/home/x/c.7z']);
    expect(added.map((i) => i.fileName)).toEqual(['b.RAR', 'c.7z']);
    const items = useQueue.getState().items;
    expect(items.map((i) => i.fileName)).toEqual(['b.RAR', 'c.7z', 'a.zip']);
    expect(items.every((i) => i.status === 'analyzing')).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });

  it('pending count excludes installed items', () => {
    const [a] = useQueue.getState().addPaths(['a.zip', 'b.zip']);
    useQueue.getState().update(a!.id, { status: 'done' });
    expect(selectPendingCount(useQueue.getState())).toBe(1);
  });
});
