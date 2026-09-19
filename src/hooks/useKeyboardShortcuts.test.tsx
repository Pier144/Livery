import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from '@/test/render';
import { toast, useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function Harness() {
  useKeyboardShortcuts();
  return <input aria-label="field" />;
}

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key: k, ...init });

describe('useKeyboardShortcuts', () => {
  beforeEach(() => resetStores());

  it('1–5 switch sections and "," opens Settings', () => {
    render(<Harness />);
    key('2');
    expect(useUi.getState().screen).toBe('hangar');
    key('4');
    expect(useUi.getState().screen).toBe('queue');
    key('5');
    expect(useUi.getState().screen).toBe('settings');
    key('1');
    key(',');
    expect(useUi.getState().screen).toBe('settings');
  });

  it('[ and ] toggle the sidebar', () => {
    render(<Harness />);
    key('[');
    expect(useUi.getState().sidebarOpen).toBe(false);
    key(']');
    expect(useUi.getState().sidebarOpen).toBe(true);
  });

  it('Ctrl+K toggles the palette and Esc closes it', () => {
    render(<Harness />);
    key('k', { ctrlKey: true });
    expect(useUi.getState().palette.open).toBe(true);
    key('Escape');
    expect(useUi.getState().palette.open).toBe(false);
    key('K', { metaKey: true });
    expect(useUi.getState().palette.open).toBe(true);
    key('k', { ctrlKey: true });
    expect(useUi.getState().palette.open).toBe(false);
  });

  it('Ctrl+Z undoes the newest undoable toast, but not while typing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { getByLabelText } = render(<Harness />);
    toast.undoable('Deleted 1 skin', first);
    toast.undoable('Deleted 2 skins', second);
    toast('Installed “X”');
    fireEvent.keyDown(getByLabelText('field'), { key: 'z', ctrlKey: true });
    expect(second).not.toHaveBeenCalled();
    key('z', { ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    key('z', { ctrlKey: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Installed “X”']);
    key('z', { ctrlKey: true });
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it('ignores section and sidebar keys during First run; Ctrl+K, Esc and Ctrl+Z still work', () => {
    const undo = vi.fn();
    render(<Harness />);
    useUi.getState().go('firstRun');
    for (const k of ['1', '2', '3', '4', '5', ',', '[', ']']) key(k);
    expect(useUi.getState().screen).toBe('firstRun');
    expect(useUi.getState().sidebarOpen).toBe(true);
    key('k', { ctrlKey: true });
    expect(useUi.getState().palette.open).toBe(true);
    key('Escape');
    expect(useUi.getState().palette.open).toBe(false);
    toast.undoable('Deleted 1 skin', undo);
    key('z', { ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    // Leaving First run (e.g. via the palette) brings the section keys back.
    useUi.getState().go('explore');
    key('2');
    expect(useUi.getState().screen).toBe('hangar');
  });

  it('ignores section keys while typing, with modifiers, or with the palette open', () => {
    const { getByLabelText } = render(<Harness />);
    fireEvent.keyDown(getByLabelText('field'), { key: '3' });
    key('3', { ctrlKey: true });
    expect(useUi.getState().screen).toBe('explore');
    useUi.getState().openPalette();
    key('2');
    expect(useUi.getState().screen).toBe('explore');
  });
});
