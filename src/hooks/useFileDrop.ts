import { useEffect } from 'react';
import i18n from '@/i18n';
import { isTauri } from '@/lib/tauri';
import { useQueue } from '@/store/queue';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';

/** Only writes on change: `over` events arrive on every mouse move. */
function setActive(active: boolean) {
  const ui = useUi.getState();
  if (ui.dragActive !== active) ui.setDragActive(active);
}

/**
 * Routes a drop:
 * - a folder drop handler is registered (First run asking for the game folder) → it gets every path, folders included;
 * - otherwise every path joins the install queue as "Analyzing…" (archives, skin folders — the backend
 *   decides; the queue drops what isn't a skin with one toast) and the app jumps to the queue —
 *   except during First run, which stays put and confirms with a toast (the sidebar badge is hidden there).
 */
export function handleDroppedPaths(paths: string[]) {
  if (paths.length === 0) return;
  const ui = useUi.getState();
  if (ui.folderDrop) {
    ui.folderDrop(paths);
    return;
  }
  const accepted = useQueue.getState().addPaths(paths);
  if (accepted.length === 0) return;
  if (ui.screen === 'firstRun') toast(i18n.t('common.drop.queued', { count: accepted.length }));
  else ui.go('queue');
}

/**
 * Tauri: with `dragDropEnabled` the webview gets no HTML5 file drags on Windows,
 * so listen to the OS drag & drop events instead (they carry real paths).
 */
function listenTauri(): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  // Non-file drags (e.g. text from another app) enter with no paths; ignore them.
  let carryingFiles = false;

  import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        switch (payload.type) {
          case 'enter':
            carryingFiles = payload.paths.length > 0;
            setActive(carryingFiles);
            break;
          case 'over':
            if (carryingFiles) setActive(true);
            break;
          case 'leave':
            carryingFiles = false;
            setActive(false);
            break;
          case 'drop':
            carryingFiles = false;
            setActive(false);
            handleDroppedPaths(payload.paths);
            break;
        }
      }),
    )
    .then((fn) => {
      // Unmounted before the listener was registered.
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e: unknown) => console.error('[livery] drag & drop listener failed', e));

  // Focus moving away mid-drag hides the overlay; a later `over` brings it back.
  const onBlur = () => setActive(false);
  window.addEventListener('blur', onBlur);
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener('blur', onBlur);
  };
}

const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Plain browser (`pnpm dev`, tests): HTML5 drag events on the window. Browsers expose names, not paths. */
function listenBrowser(): () => void {
  // enter/leave fire for every element crossed; count them so moving over children doesn't flicker.
  let depth = 0;

  const onEnter = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth += 1;
    setActive(true);
  };
  const onOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    // Cancelling dragover is what allows the drop (instead of the browser opening the file).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (depth === 0) depth = 1; // re-sync after a blur reset while still over the window
    setActive(true);
  };
  const onLeave = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setActive(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setActive(false);
    const files = e.dataTransfer?.files;
    handleDroppedPaths(files ? Array.from(files, (f) => f.name) : []);
  };
  const onBlur = () => {
    depth = 0;
    setActive(false);
  };

  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragover', onOver);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('blur', onBlur);
  };
}

/** Window-level file drag & drop → overlay (`dragActive`) and install queue (or `folderDrop`). Call once, in `App`. */
export function useFileDrop() {
  useEffect(() => {
    const stop = isTauri() ? listenTauri() : listenBrowser();
    return () => {
      stop();
      setActive(false);
    };
  }, []);
}
