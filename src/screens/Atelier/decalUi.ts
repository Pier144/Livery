import { create } from 'zustand';

/**
 * Editor UI state around image and text layers that isn't part of the project (never saved, never
 * undone): which pictures couldn't be read, which decals land on shared texels (Mirror is then
 * offered off), the layer being placed again, and whether background removal is busy (Settings
 * disables Remove meanwhile). Picture sizes are remembered outside React (Remove background
 * needs the source's size; nothing renders from it).
 */
interface DecalUiState {
  /** Asset ids `atelier_asset` couldn't serve (the layer shows a warning). */
  missingAssets: Record<string, true>;
  /** Per layer id: its decal lands on texels more than one triangle draws (from the last check). */
  shared: Record<string, boolean>;
  /** A placed layer whose decal didn't check out, waiting for its placement click (Place again). */
  placingLayerId: string | null;
  /** A background-removal download or cutout is running. */
  cutoutBusy: boolean;
  /** Bumped when a text layer's font finished loading (or turned out missing): warnings re-read `fontStatus`. */
  fontsVersion: number;
  /** The gizmo snaps moves and turns (`decalSnap.ts`); the view's magnet button toggles it. */
  snap: boolean;
}

const INITIAL: DecalUiState = { missingAssets: {}, shared: {}, placingLayerId: null, cutoutBusy: false, fontsVersion: 0, snap: true };

export const useDecalUi = create<DecalUiState>()(() => ({ ...INITIAL }));

export function setAssetMissing(assetId: string, missing: boolean): void {
  const { missingAssets } = useDecalUi.getState();
  if (Boolean(missingAssets[assetId]) === missing) return;
  const next = { ...missingAssets };
  if (missing) next[assetId] = true;
  else delete next[assetId];
  useDecalUi.setState({ missingAssets: next });
}

export function setShared(layerId: string, shared: boolean): void {
  if (useDecalUi.getState().shared[layerId] === shared) return;
  useDecalUi.setState((s) => ({ shared: { ...s.shared, [layerId]: shared } }));
}

export function setPlacingLayer(layerId: string | null): void {
  useDecalUi.setState({ placingLayerId: layerId });
}

export function setCutoutBusy(busy: boolean): void {
  useDecalUi.setState({ cutoutBusy: busy });
}

export function setSnap(snap: boolean): void {
  useDecalUi.setState({ snap });
}

export function bumpFonts(): void {
  useDecalUi.setState((s) => ({ fontsVersion: s.fontsVersion + 1 }));
}

const sizes = new Map<string, { width: number; height: number }>();

/** Remembers a picture's size (from an import, a cutout, a read). */
export function noteAssetSize(assetId: string, width: number, height: number): void {
  sizes.set(assetId, { width, height });
}

/** A picture's size if it was seen this session. */
export function assetSize(assetId: string): { width: number; height: number } | undefined {
  return sizes.get(assetId);
}

/** Back to the initial state (closing a project, tests). The cutout's busy flag outlives a project. */
export function resetDecalUi(): void {
  const { cutoutBusy } = useDecalUi.getState();
  useDecalUi.setState({ ...INITIAL, cutoutBusy });
}
