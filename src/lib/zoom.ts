import { isTauri } from '@/lib/tauri';

/**
 * Interface size steps (Settings → General → Interface size, Ctrl + / Ctrl − / Ctrl 0). Text and
 * controls grow together, like a browser's page zoom. 150 % is the top: at the 1100×700 minimum
 * window it leaves a 733×467 layout, the smallest that still works in every screen.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const ZOOM_DEFAULT = 1;

/** A stored value back to a known step (anything else, e.g. an old or hand-edited one, is 100 %). */
export function normalizeZoom(value: unknown): number {
  return ZOOM_STEPS.find((step) => step === value) ?? ZOOM_DEFAULT;
}

/** The next step up (`1`) or down (`-1`) from `current`; stays put at either end. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((step) => step === normalizeZoom(current));
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))] ?? ZOOM_DEFAULT;
}

/** "125%" in the UI language ("125 %" in French). */
export function formatZoom(zoom: number, language: string): string {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(zoom);
}

/**
 * Applies the zoom. In the app it is the webview's own zoom, so pointer coordinates, media queries
 * and the Atelier canvas all stay consistent; in a plain browser (dev, mock) CSS `zoom` on the root
 * stands in for it. Failures are logged: the interface just stays at its current size.
 */
export async function applyZoom(zoom: number): Promise<void> {
  if (!isTauri()) {
    document.documentElement.style.zoom = zoom === ZOOM_DEFAULT ? '' : String(zoom);
    return;
  }
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().setZoom(zoom);
  } catch (e) {
    console.warn('[livery] setting the interface size failed', e);
  }
}
