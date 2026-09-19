import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetStores } from '@/test/render';
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
