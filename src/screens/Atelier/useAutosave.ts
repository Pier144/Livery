import { useCallback, useEffect, useRef, useState } from 'react';
import { currentProject, useAtelierEditor } from '@/atelier/editorStore';
import { useSaveProject } from '@/queries/atelier';

/** Quiet time after the last change before the project is saved. */
export const AUTOSAVE_MS = 1000;

export type SaveState = 'saved' | 'saving' | 'error';

/**
 * Saves the open project about a second after the last change (`atelier_project_save`), one save
 * at a time; a change made while a save is on its way is saved after it. `flush()` saves now
 * (before an apply) and resolves once nothing is left to save; leaving the editor flushes too.
 * A failed save shows as `error` and is tried again at the next change.
 */
export function useAutosave(delayMs = AUTOSAVE_MS): { saveState: SaveState; flush: () => Promise<void> } {
  const { mutateAsync } = useSaveProject();
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const save = useRef(mutateAsync);
  save.current = mutateAsync;

  const show = (state: SaveState) => {
    if (mounted.current) setSaveState(state);
  };

  /** Saves the store's project if it is dirty, after any save already on its way. */
  const saveNow = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const run = async (): Promise<void> => {
      const state = useAtelierEditor.getState();
      const project = currentProject(state);
      if (!state.dirty || !project || state.stroking) return;
      const { revision } = state;
      show('saving');
      try {
        const saved = await save.current(project);
        useAtelierEditor.getState().markSaved(saved, revision);
        show(useAtelierEditor.getState().dirty ? 'saving' : 'saved');
      } catch {
        show('error');
      }
    };
    const next = (inFlight.current ?? Promise.resolve()).then(run);
    inFlight.current = next;
    void next.finally(() => {
      if (inFlight.current === next) inFlight.current = null;
    });
    return next;
  }, []);

  /** Saves until nothing is dirty (a change made during a save gets its own save). */
  const flush = useCallback(async (): Promise<void> => {
    await saveNow();
    if (useAtelierEditor.getState().dirty) await saveNow();
  }, [saveNow]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAtelierEditor.subscribe((state, prev) => {
      const strokeEnded = prev.stroking && !state.stroking;
      if (!state.dirty || (state.revision === prev.revision && !strokeEnded)) return;
      if (timer.current) clearTimeout(timer.current);
      // While a stroke is drawn the timer keeps restarting with each point; it saves after it.
      timer.current = setTimeout(() => void saveNow(), delayMs);
    });
    // A project opened dirty (a repaired file, a new project's Base) is saved too.
    if (useAtelierEditor.getState().dirty) timer.current = setTimeout(() => void saveNow(), delayMs);
    return () => {
      mounted.current = false;
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // Leaving the editor: whatever is pending is saved now.
      void saveNow();
    };
  }, [delayMs, saveNow]);

  return { saveState, flush };
}
