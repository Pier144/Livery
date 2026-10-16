import { useCallback, useEffect, useRef, useState } from 'react';
import { currentProject, useAtelierEditor } from '@/atelier/editorStore';
import { useSaveProject } from '@/queries/atelier';
import type { AtelierProject } from '@/types';

/** Quiet time after the last change before the project is saved. */
export const AUTOSAVE_MS = 1000;

export type SaveState = 'saved' | 'saving' | 'error';

/** What one queued save did. */
type Outcome = 'saved' | 'failed' | 'skipped';

/** The last queued save of every editor instance (a closed editor's leave-save may still be running). */
const queues = new Set<Promise<Outcome>>();

/**
 * Resolves once every save queued so far (by any editor, including one just closed) has
 * finished, whatever its outcome. Opening a project waits for it before the asset GC
 * (`atelier_project_open`) and the fresh read, so neither sees an older file than the last edit.
 */
export async function savesSettled(): Promise<void> {
  while (queues.size > 0) await Promise.allSettled([...queues]);
}

/**
 * Saves the open project about a second after the last change (`atelier_project_save`), one save
 * at a time; a change made while a save is on its way is saved after it. A failed save shows as
 * `error` and is tried again at the next change.
 *
 * `flush()` saves now (before an apply) and resolves `true` once everything is saved, `false`
 * when a save failed or a stroke is still being drawn (the caller must not go on as if saved).
 *
 * Leaving the editor (unmount) takes a copy of the project and its revision at that moment and
 * saves that copy after any save on its way, so an edit survives the store being reset or another
 * project being loaded right after.
 */
export function useAutosave(delayMs = AUTOSAVE_MS): { saveState: SaveState; flush: () => Promise<boolean> } {
  const { mutateAsync } = useSaveProject();
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<Outcome>>(Promise.resolve('skipped'));
  const mounted = useRef(true);
  const save = useRef(mutateAsync);
  save.current = mutateAsync;

  const show = (state: SaveState) => {
    if (mounted.current) setSaveState(state);
  };

  /** Runs `task` after every save already queued. */
  const enqueue = useCallback((task: () => Promise<Outcome>): Promise<Outcome> => {
    const next = queue.current.then(task, task);
    queue.current = next;
    queues.add(next);
    const done = () => {
      queues.delete(next);
    };
    next.then(done, done);
    return next;
  }, []);

  /** Saves `project` (as it was at `revision`). */
  const send = useCallback(async (project: AtelierProject, revision: number): Promise<Outcome> => {
    show('saving');
    try {
      const saved = await save.current(project);
      // A no-op once the store holds another project (or none).
      useAtelierEditor.getState().markSaved(saved, revision);
      const { project: open, dirty } = useAtelierEditor.getState();
      show(open?.id === project.id && dirty ? 'saving' : 'saved');
      return 'saved';
    } catch {
      show('error');
      return 'failed';
    }
  }, []);

  /** Saves the store's project as it is when the queued save starts, if it is dirty and no stroke is being drawn. */
  const saveNow = useCallback((): Promise<Outcome> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return enqueue(async () => {
      const state = useAtelierEditor.getState();
      const project = currentProject(state);
      if (!state.dirty || !project || state.stroking) return 'skipped';
      return send(project, state.revision);
    });
  }, [enqueue, send]);

  const flush = useCallback(async (): Promise<boolean> => {
    let outcome = await saveNow();
    // A change made during that save gets its own.
    if (outcome !== 'failed' && useAtelierEditor.getState().dirty) outcome = await saveNow();
    const { dirty, stroking } = useAtelierEditor.getState();
    return outcome !== 'failed' && !dirty && !stroking;
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
      // Leaving the editor: the project as it is now is saved, whatever the store holds later.
      const state = useAtelierEditor.getState();
      const project = currentProject(state);
      if (state.dirty && project) {
        const { revision } = state;
        void enqueue(() => send(project, revision));
      }
    };
  }, [delayMs, saveNow, enqueue, send]);

  return { saveState, flush };
}
