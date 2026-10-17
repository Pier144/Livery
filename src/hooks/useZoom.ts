import { useEffect, useLayoutEffect } from 'react';
import i18n from '@/i18n';
import { applyZoom, formatZoom, ZOOM_DEFAULT } from '@/lib/zoom';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';

/** Ctrl+wheel: this much accumulated wheel delta makes one step (a mouse notch is ~100). */
const WHEEL_STEP_DELTA = 60;
/** A pause this long starts a new Ctrl+wheel gesture (the accumulator forgets the old one). */
const WHEEL_IDLE_MS = 250;

let noticeId: number | null = null;

/** One toast saying the new size; a second change replaces it instead of stacking. */
function notice() {
  if (noticeId !== null) toast.dismiss(noticeId);
  const percent = formatZoom(useUi.getState().zoom, i18n.language);
  noticeId = toast(i18n.t('common.zoom.notice', { percent }));
}

/** Ctrl + / Ctrl − (and Ctrl+wheel): one step, with a toast saying the new size. Nothing at either end. */
export function zoomBy(dir: 1 | -1) {
  const before = useUi.getState().zoom;
  useUi.getState().stepZoom(dir);
  if (useUi.getState().zoom !== before) notice();
}

/** Ctrl 0: back to 100 %, with the toast. */
export function resetZoom() {
  if (useUi.getState().zoom === ZOOM_DEFAULT) return;
  useUi.getState().setZoom(ZOOM_DEFAULT);
  notice();
}

/**
 * Applies the interface size (stored in `useUi`, so it is known before the first paint) whenever
 * it changes, and zooms with Ctrl+wheel. A wheel a screen already handles (the Atelier view, the
 * Refine edge picture) is left alone: those call `preventDefault` first.
 */
export function useZoom() {
  const zoom = useUi((s) => s.zoom);
  useLayoutEffect(() => {
    void applyZoom(zoom);
  }, [zoom]);

  useEffect(() => {
    let acc = 0;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      // Without this the webview would scroll (its own Ctrl+wheel zoom is turned off).
      e.preventDefault();
      if (e.timeStamp - last > WHEEL_IDLE_MS) acc = 0;
      last = e.timeStamp;
      acc += e.deltaY;
      if (Math.abs(acc) < WHEEL_STEP_DELTA) return;
      zoomBy(acc < 0 ? 1 : -1);
      acc = 0;
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);
}
