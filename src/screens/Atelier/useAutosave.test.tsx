import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentProject, resetAtelierEditor, useAtelierEditor } from '@/atelier/editorStore';
import { baseOf, type Layer } from '@/atelier/project';
import { createQueryClient } from '@/queries/client';
import { resetStores } from '@/test/render';
import type { AtelierProject } from '@/types';
import { AUTOSAVE_MS, useAutosave } from './useAutosave';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

const PROJECT: AtelierProject = {
  version: 1,
  id: 'p-1',
  name: 'Desert',
  vehicle: 'germ_leopard_2a6',
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  slots: [{ texture: 'v_body_c', enabled: true }],
  output: { highQuality: false },
  layers: [],
};

const S = () => useAtelierEditor.getState();
const saves = () => backend.call.mock.calls.filter(([cmd]) => cmd === 'atelier_project_save');

function mount() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useAutosave(), { wrapper });
}

/** Lets the save promise chain settle under fake timers. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStores();
  backend.call.mockReset();
  backend.call.mockImplementation(async (cmd, args) =>
    cmd === 'atelier_project_save' ? { ...(args?.project as AtelierProject), updatedAt: '2026-10-16T10:01:00Z' } : null,
  );
  // A valid project: opening it is clean.
  S().load(PROJECT);
  const layers = currentProject(S())!.layers;
  S().load({ ...PROJECT, layers });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutosave', () => {
  it('saves once, a second after the last change', async () => {
    const { result } = mount();
    act(() => S().setBase({ seed: 2 }));
    act(() => vi.advanceTimersByTime(600));
    act(() => S().setBase({ seed: 3 }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS - 1));
    expect(saves()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    await settle();
    expect(saves()).toHaveLength(1);
    expect((saves()[0]?.[1]?.project as AtelierProject).layers).toEqual(S().layers);
    expect(S().dirty).toBe(false);
    expect(result.current.saveState).toBe('saved');
  });

  it('saves a project opened dirty (a new project gets its Base saved)', async () => {
    S().load(PROJECT);
    mount();
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS));
    await settle();
    expect(saves()).toHaveLength(1);
  });

  it('waits for the end of a stroke', async () => {
    mount();
    act(() => {
      S().beginStroke({ erase: false, radius: 0.1, hardness: 0.5, part: 'all', dir: [0, 0, -1] });
      S().extendStroke([0, 0, 0]);
    });
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS * 3));
    await settle();
    expect(saves()).toHaveLength(0);
    act(() => S().endStroke());
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS));
    await settle();
    expect(saves()).toHaveLength(1);
  });

  it('shows an error and stays dirty when the save fails', async () => {
    backend.call.mockRejectedValue({ code: 'io', message: 'Could not save the Atelier project' });
    const { result } = mount();
    act(() => S().setBase({ seed: 2 }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS));
    await settle();
    expect(result.current.saveState).toBe('error');
    expect(S().dirty).toBe(true);
  });

  it('flush saves at once and says whether everything is saved', async () => {
    const { result } = mount();
    act(() => S().setBase({ seed: 2 }));
    expect(await act(() => result.current.flush())).toBe(true);
    expect(saves()).toHaveLength(1);
    expect(S().dirty).toBe(false);

    backend.call.mockRejectedValueOnce({ code: 'io', message: 'Could not save the Atelier project' });
    act(() => S().setBase({ seed: 3 }));
    expect(await act(() => result.current.flush())).toBe(false);
    expect(S().dirty).toBe(true);

    act(() => {
      S().beginStroke({ erase: false, radius: 0.1, hardness: 0.5, part: 'all', dir: [0, 0, -1] });
      S().extendStroke([0, 0, 0]);
    });
    expect(await act(() => result.current.flush())).toBe(false);
    act(() => S().endStroke());
    expect(await act(() => result.current.flush())).toBe(true);
  });

  it('an edit made during a slow save gets a second save', async () => {
    let finish: () => void = () => {};
    backend.call.mockImplementationOnce(
      (_cmd, args) =>
        new Promise((resolve) => {
          finish = () => resolve(args?.project);
        }),
    );
    mount();
    act(() => S().setBase({ seed: 2 }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS));
    await settle();
    expect(saves()).toHaveLength(1);
    act(() => S().setBase({ seed: 3 }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_MS));
    await settle();
    // One save at a time: the second waits for the first.
    expect(saves()).toHaveLength(1);
    expect(S().dirty).toBe(true);
    await act(async () => finish());
    await settle();
    expect(saves()).toHaveLength(2);
    expect(baseOf((saves()[1]?.[1]?.project as AtelierProject).layers as Layer[])?.seed).toBe(3);
    expect(S().dirty).toBe(false);
  });

  it('leaving the editor saves a copy taken then, even when the store is reset right after', async () => {
    const { unmount } = mount();
    act(() => S().setBase({ seed: 7 }));
    unmount();
    resetAtelierEditor();
    await settle();
    expect(saves()).toHaveLength(1);
    const sent = saves()[0]?.[1]?.project as AtelierProject;
    expect(sent.id).toBe('p-1');
    expect(baseOf(sent.layers as Layer[])?.seed).toBe(7);
  });
});
