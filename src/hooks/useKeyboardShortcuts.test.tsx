import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from '@/test/render';
import { toast, useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useScreenFocus } from './useScreenFocus';

/** App mounts both: the shortcuts change the screen, useScreenFocus moves focus there. */
function Harness() {
  useKeyboardShortcuts();
  useScreenFocus();
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

  it('a section key moves focus to the new screen’s heading, so the screen is announced', () => {
    // The screen's h1 as App renders it inside <main>.
    function Shell() {
      useKeyboardShortcuts();
      useScreenFocus();
      const current = useUi((s) => s.screen);
      return (
        <main>
          <h1 tabIndex={-1}>{`heading:${current}`}</h1>
          <button type="button">control</button>
        </main>
      );
    }
    render(<Shell />);
    expect(document.body).toHaveFocus();
    key('2');
    expect(screen.getByRole('heading', { name: 'heading:hangar' })).toHaveFocus();

    // The section that is already shown: focus stays where it is.
    screen.getByRole('button', { name: 'control' }).focus();
    key('2');
    expect(screen.getByRole('button', { name: 'control' })).toHaveFocus();
    key('5');
    expect(screen.getByRole('heading', { name: 'heading:settings' })).toHaveFocus();
  });

  it('back from the Skin detail: focus returns to the skin’s card, else to the heading', () => {
    function Shell() {
      useKeyboardShortcuts();
      useScreenFocus();
      const current = useUi((s) => s.screen);
      return (
        <main>
          <h1 tabIndex={-1}>{`heading:${current}`}</h1>
          {current === 'hangar' && (
            // A My Hangar card installed from WT Live post s1 (full-card hit area inside).
            <div role="group" aria-label="Ambush" data-skin-id="h1" data-source-id="s1">
              <div role="button" tabIndex={0} aria-label="Ambush" />
            </div>
          )}
        </main>
      );
    }
    render(<Shell />);
    act(() => {
      useUi.getState().go('hangar');
      useUi.getState().openSkin('s1');
    });
    act(() => useUi.getState().leaveDetail());
    expect(useUi.getState().screen).toBe('hangar');
    expect(screen.getByRole('button', { name: 'Ambush' })).toHaveFocus();
    expect(useUi.getState().returnFocusSkin).toBeNull();

    // A skin whose card isn't on the screen it returns to.
    act(() => {
      useUi.getState().go('collections');
      useUi.getState().openSkin('s9');
    });
    act(() => useUi.getState().leaveDetail());
    expect(screen.getByRole('heading', { name: 'heading:collections' })).toHaveFocus();
  });

  it('a screen change that removed the focused control puts focus on the new heading', () => {
    function Shell() {
      useKeyboardShortcuts();
      useScreenFocus();
      const current = useUi((s) => s.screen);
      return (
        <main>
          <h1 tabIndex={-1}>{`heading:${current}`}</h1>
          {current === 'explore' ? (
            // Like the offline state's "Open My Hangar": the button goes away with the screen.
            <button type="button" onClick={() => useUi.getState().go('hangar')}>
              Open My Hangar
            </button>
          ) : (
            <button type="button">stays</button>
          )}
        </main>
      );
    }
    render(<Shell />);
    act(() => screen.getByRole('button', { name: 'Open My Hangar' }).click());
    expect(screen.getByRole('heading', { name: 'heading:hangar' })).toHaveFocus();

    // Focus that survives the change (a sidebar button, say) is left alone.
    screen.getByRole('button', { name: 'stays' }).focus();
    act(() => useUi.getState().go('queue'));
    expect(screen.getByRole('button', { name: 'stays' })).toHaveFocus();
  });

  it('Ctrl+K does not open the palette over a modal dialog (its results would navigate under it)', () => {
    render(
      <>
        <Harness />
        <div role="dialog" aria-modal="true" aria-label="Licenses" />
      </>,
    );
    key('k', { ctrlKey: true });
    expect(useUi.getState().palette.open).toBe(false);
    // Opened another way, Ctrl+K still closes it.
    act(() => useUi.getState().openPalette());
    key('k', { ctrlKey: true });
    expect(useUi.getState().palette.open).toBe(false);
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
