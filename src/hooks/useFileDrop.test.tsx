import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/en.json';
import { useQueue } from '@/store/queue';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { resetStores } from '@/test/render';
import { handleDroppedPaths, useFileDrop } from './useFileDrop';

type DragDropHandler = (event: { payload: Record<string, unknown> }) => void;

const tauri = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as DragDropHandler | undefined,
  unlisten: vi.fn(),
  /** Resolves the `onDragDropEvent` registration; replaced to test unmount-before-resolve. */
  register: undefined as (() => Promise<() => void>) | undefined,
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => tauri.enabled,
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: DragDropHandler) => {
      tauri.handler = handler;
      return tauri.register ? tauri.register() : Promise.resolve(tauri.unlisten);
    },
  }),
}));

function Harness() {
  useFileDrop();
  return (
    <div data-testid="outer">
      <span data-testid="inner">content</span>
    </div>
  );
}

const files = (...names: string[]) => ({
  types: ['Files'],
  files: names.map((n) => new File(['x'], n)),
});

const active = () => useUi.getState().dragActive;
const messages = () => useToasts.getState().toasts.map((t) => t.message);

describe('useFileDrop — browser', () => {
  beforeEach(() => {
    resetStores();
    tauri.enabled = false;
  });

  it('shows the overlay state when files are dragged onto the window', () => {
    render(<Harness />);
    expect(active()).toBe(false);
    fireEvent.dragEnter(window, { dataTransfer: files() });
    expect(active()).toBe(true);
  });

  it('does not flicker when crossing child elements, and clears when leaving the window', () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.dragEnter(getByTestId('outer'), { dataTransfer: files() });
    // Entering the child fires before leaving the parent.
    fireEvent.dragEnter(getByTestId('inner'), { dataTransfer: files() });
    fireEvent.dragLeave(getByTestId('outer'), { dataTransfer: files() });
    expect(active()).toBe(true);
    fireEvent.dragOver(getByTestId('inner'), { dataTransfer: files() });
    expect(active()).toBe(true);
    fireEvent.dragLeave(getByTestId('inner'), { dataTransfer: files() });
    expect(active()).toBe(false);
  });

  it('cancels dragover and drop so the browser does not open the file', () => {
    render(<Harness />);
    fireEvent.dragEnter(window, { dataTransfer: files() });
    expect(fireEvent.dragOver(window, { dataTransfer: files() })).toBe(false);
    expect(fireEvent.drop(window, { dataTransfer: files('notes.txt') })).toBe(false);
  });

  it('adds only archives to the queue and opens the queue', () => {
    render(<Harness />);
    fireEvent.dragEnter(window, { dataTransfer: files() });
    fireEvent.drop(window, { dataTransfer: files('a.zip', 'notes.txt') });
    expect(active()).toBe(false);
    const items = useQueue.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: 'a.zip', fileName: 'a.zip', status: 'analyzing' });
    expect(useUi.getState().screen).toBe('queue');
    expect(messages()).toEqual([]);
  });

  it('toasts and stays put when nothing dropped is an archive', () => {
    useUi.getState().go('hangar');
    render(<Harness />);
    fireEvent.dragEnter(window, { dataTransfer: files() });
    fireEvent.drop(window, { dataTransfer: files('notes.txt', 'preview.png') });
    expect(active()).toBe(false);
    expect(useQueue.getState().items).toEqual([]);
    expect(useUi.getState().screen).toBe('hangar');
    expect(messages()).toEqual([en.common.drop.unsupported]);
  });

  it('ignores drags that carry no files', () => {
    render(<Harness />);
    const text = { types: ['text/plain'], files: [] };
    fireEvent.dragEnter(window, { dataTransfer: text });
    expect(active()).toBe(false);
    expect(fireEvent.dragOver(window, { dataTransfer: text })).toBe(true);
    expect(active()).toBe(false);
    expect(fireEvent.drop(window, { dataTransfer: text })).toBe(true);
    expect(useUi.getState().screen).toBe('explore');
    expect(messages()).toEqual([]);
  });

  it('clears the state on window blur and on unmount', () => {
    const { unmount } = render(<Harness />);
    fireEvent.dragEnter(window, { dataTransfer: files() });
    fireEvent.blur(window);
    expect(active()).toBe(false);
    // Still over the window: the next dragover brings the overlay back.
    fireEvent.dragOver(window, { dataTransfer: files() });
    expect(active()).toBe(true);
    unmount();
    expect(active()).toBe(false);
    fireEvent.dragEnter(window, { dataTransfer: files() });
    expect(active()).toBe(false);
  });
});

describe('useFileDrop — Tauri', () => {
  const emit = (payload: Record<string, unknown>) => act(() => tauri.handler?.({ payload }));
  const position = { x: 10, y: 10 };

  beforeEach(() => {
    resetStores();
    tauri.enabled = true;
    tauri.handler = undefined;
    tauri.register = undefined;
    tauri.unlisten.mockClear();
  });

  afterEach(() => {
    tauri.enabled = false;
  });

  it('follows enter / over / leave from the webview', async () => {
    render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    emit({ type: 'enter', paths: ['C:\\Skins\\tiger.zip'], position });
    expect(active()).toBe(true);
    emit({ type: 'over', position });
    expect(active()).toBe(true);
    emit({ type: 'leave' });
    expect(active()).toBe(false);
  });

  it('clears on window blur and comes back on the next over while files are still dragged', async () => {
    render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    emit({ type: 'enter', paths: ['C:\\Skins\\tiger.zip'], position });
    act(() => void fireEvent.blur(window));
    expect(active()).toBe(false);
    emit({ type: 'over', position });
    expect(active()).toBe(true);
    emit({ type: 'leave' });
    emit({ type: 'over', position });
    expect(active()).toBe(false);
  });

  it('ignores HTML5 drag events inside the app window', async () => {
    render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    fireEvent.dragEnter(window, { dataTransfer: files() });
    expect(active()).toBe(false);
  });

  it('adds dropped archive paths to the queue and opens it', async () => {
    render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    const paths = ['C:\\Skins\\tiger.zip', 'C:\\Skins\\readme.txt'];
    emit({ type: 'enter', paths, position });
    emit({ type: 'drop', paths, position });
    expect(active()).toBe(false);
    const items = useQueue.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: 'C:\\Skins\\tiger.zip', fileName: 'tiger.zip', status: 'analyzing' });
    expect(useUi.getState().screen).toBe('queue');
  });

  it('toasts when the drop has no archives', async () => {
    render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    emit({ type: 'enter', paths: ['C:\\Skins'], position });
    emit({ type: 'drop', paths: ['C:\\Skins'], position });
    expect(useQueue.getState().items).toEqual([]);
    expect(useUi.getState().screen).toBe('explore');
    expect(messages()).toEqual([en.common.drop.unsupported]);
  });

  it('keeps the overlay down for drags without paths', async () => {
    render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    emit({ type: 'enter', paths: [], position });
    emit({ type: 'over', position });
    expect(active()).toBe(false);
  });

  it('unlistens on unmount', async () => {
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    emit({ type: 'enter', paths: ['C:\\Skins\\tiger.zip'], position });
    unmount();
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
    expect(active()).toBe(false);
  });

  it('unlistens once registration resolves if it unmounted first', async () => {
    let resolve: (fn: () => void) => void = () => {};
    tauri.register = () => new Promise((r) => (resolve = r));
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(tauri.handler).toBeDefined());
    unmount();
    expect(tauri.unlisten).not.toHaveBeenCalled();
    resolve(tauri.unlisten);
    await waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(1));
  });
});

describe('handleDroppedPaths', () => {
  beforeEach(() => resetStores());

  it('does nothing for an empty drop', () => {
    handleDroppedPaths([]);
    expect(useQueue.getState().items).toEqual([]);
    expect(messages()).toEqual([]);
  });
});
