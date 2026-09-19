import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from '@/test/render';
import { TOAST_DURATION_MS, toast, useToasts } from './toasts';
import { detailReturnFor, useUi } from './ui';

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

  it('remembers where the Skin detail was opened from', () => {
    const ui = useUi.getState();
    expect(useUi.getInitialState().detailReturnTo).toBe('explore');
    ui.go('hangar');
    ui.openPalette();
    ui.openSkin('s1');
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's1', detailReturnTo: 'hangar' });
    expect(useUi.getState().palette.open).toBe(false);
    // Another skin opened from the detail (palette) keeps the first opener.
    ui.openSkin('s2');
    expect(useUi.getState()).toMatchObject({ detailSkinId: 's2', detailReturnTo: 'hangar' });
    ui.go('settings');
    ui.openSkin('s3');
    expect(useUi.getState().detailReturnTo).toBe('settings');
  });

  it('sends the Skin detail back to Explore when it was opened from First run', () => {
    useUi.getState().startFirstRun({ step: 'choose', returnTo: 'settings' });
    useUi.getState().openSkin('s1');
    expect(useUi.getState().detailReturnTo).toBe('explore');
    expect(detailReturnFor('collections', 'hangar')).toBe('collections');
    expect(detailReturnFor('detail', 'queue')).toBe('queue');
  });

  it('leaveDetail goes back to the opener and remembers which card gets focus; any go drops it', () => {
    const ui = useUi.getState();
    ui.go('hangar');
    ui.openSkin('s1');
    ui.openPalette();
    useUi.getState().leaveDetail();
    expect(useUi.getState()).toMatchObject({ screen: 'hangar', returnFocusSkin: 's1', palette: { open: false } });
    // Taken once.
    expect(useUi.getState().takeReturnFocus()).toBe('s1');
    expect(useUi.getState().takeReturnFocus()).toBeNull();

    ui.openSkin('s2');
    useUi.getState().leaveDetail();
    useUi.getState().go('queue');
    expect(useUi.getState().returnFocusSkin).toBeNull();
    ui.openSkin('s3');
    expect(useUi.getState().returnFocusSkin).toBeNull();
  });

  it('focusHeading bumps a counter; leaving a detail with no skin asks for the heading', () => {
    const start = useUi.getState().headingFocus;
    useUi.getState().focusHeading();
    expect(useUi.getState().headingFocus).toBe(start + 1);
    useUi.setState({ screen: 'detail', detailSkinId: null, detailReturnTo: 'collections' });
    useUi.getState().leaveDetail();
    expect(useUi.getState()).toMatchObject({ screen: 'collections', returnFocusSkin: null, headingFocus: start + 2 });
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
