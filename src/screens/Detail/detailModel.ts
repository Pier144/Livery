import type { TFunction } from 'i18next';
import { formatShortDate } from '@/lib/format';
import type { WtInstall } from '@/store/installs';
import type { HangarSkin, InstallStep, TextureInfo, WtLiveSkin } from '@/types';

/** Tabs of the Skin detail, in their visual order. */
export const DETAIL_TABS = ['gallery', 'textures', 'try'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/**
 * Try in game view: `idle` (nothing installed), `installing` (a temporary install is running, or
 * finished and waiting for the hangar refetch), `active` (the skin is in the game temporarily),
 * `kept` (installed for good, e.g. after Keep: nothing left to try).
 */
export type TryState = 'idle' | 'installing' | 'active' | 'kept';

export function deriveTryState(track: WtInstall | undefined, hangarSkin: HangarSkin | undefined): TryState {
  if (hangarSkin?.temporary) return 'active';
  if (track && track.mode === 'temporary' && track.step !== 'error') return 'installing';
  if (hangarSkin) return 'kept';
  return 'idle';
}

/** Placeholder views shown when the post has no images (README: Front / Side / Rear / Detail). */
export const PLACEHOLDER_VIEWS = ['front', 'side', 'rear', 'detail'] as const;
export type PlaceholderView = (typeof PLACEHOLDER_VIEWS)[number];

export interface GalleryView {
  key: string;
  /** 1-based position. */
  n: number;
  /** A real image from the post. */
  src?: string;
  /** A placeholder view (no images on the post). */
  view?: PlaceholderView;
}

export function galleryViews(images: readonly string[]): GalleryView[] {
  if (images.length > 0) return images.map((src, i) => ({ key: `image-${i}`, n: i + 1, src }));
  return PLACEHOLDER_VIEWS.map((view, i) => ({ key: view, n: i + 1, view }));
}

/** Moves a roving index with the arrow keys, Home and End (wrapping). Null for other keys. */
export function rovingIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Other skins of the same vehicle, from any number of result lists (first appearance wins, the
 * skin itself left out). Lists may hold other vehicles (e.g. placeholder data of a previous query).
 */
export function sameVehicleSkins(skin: Pick<WtLiveSkin, 'id' | 'vehicle'>, lists: ReadonlyArray<readonly WtLiveSkin[] | undefined>): WtLiveSkin[] {
  const seen = new Set<string>([skin.id]);
  const out: WtLiveSkin[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (item.vehicle.code !== skin.vehicle.code || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// ── Textures ────────────────────────────────────────────────────────────────

export const isBlkRow = (t: TextureInfo) => t.format?.toUpperCase() === 'BLK' || /\.blk$/i.test(t.file);

/** Textures first (in the backend's order), the blk last (README: "the BLK row last"). */
export function orderTextures(rows: readonly TextureInfo[]): TextureInfo[] {
  return [...rows.filter((t) => !isBlkRow(t)), ...rows.filter(isBlkRow)];
}

export const needsAttention = (t: TextureInfo) => !!(t.warningKind || t.warning || t.missing);

/** Bytes on disk of the rows that exist (missing ones count 0). */
export const texturesTotal = (rows: readonly TextureInfo[]) => rows.reduce((sum, t) => sum + (t.missing ? 0 : (t.sizeBytes ?? 0)), 0);

/** "4096×4096", or "—" when missing or unknown. */
export function resolutionText(t: TextureInfo): string {
  if (t.missing || t.width === undefined || t.height === undefined) return '—';
  return `${t.width}×${t.height}`;
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Texture sizes keep one decimal, as in the Textures tab ("21.3 MB", "85.3 MB", "2 KB"). */
export function formatTextureSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

/**
 * The amber line under a texture row, in the UI language by `warningKind`; the backend's English
 * text is the fallback for kinds this build doesn't know. Null when the row is fine.
 */
export function textureWarning(t: TFunction, row: TextureInfo): string | null {
  switch (row.warningKind) {
    case 'heavy':
      return t('detail.textures.warning.heavy', { size: row.width ?? row.height ?? '?' });
    case 'notSquarePow2':
      return t('detail.textures.warning.notSquarePow2', { resolution: resolutionText(row) });
    case 'unreadable':
      return t('detail.textures.warning.unreadable');
    case 'missing':
      return t('detail.textures.warning.missing');
    default:
      if (row.warning) return row.warning;
      return row.missing ? t('detail.textures.warning.missing') : null;
  }
}

// ── Install progress (side panel) ───────────────────────────────────────────

const STEP_ORDER: readonly InstallStep[] = ['download', 'extract', 'verify', 'done'];

export interface StepParts {
  /** Finished steps, each drawn with a check. */
  done: Array<Exclude<InstallStep, 'done' | 'error'>>;
  /** The step running now ("Extracting 56%"), or `done`. */
  now: Exclude<InstallStep, 'error'>;
}

/** Splits a WT Live install's step into finished steps and the current one (prototype `stepOf`). */
export function stepParts(step: InstallStep): StepParts {
  const now = step === 'error' ? 'download' : step;
  const index = STEP_ORDER.indexOf(now);
  return { done: STEP_ORDER.slice(0, index) as StepParts['done'], now };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Intl locale for the UI language (English counts use en-GB, as the dates do: "24,120"). */
export const intlLocale = (language: string) => (language.startsWith('en') ? 'en-GB' : language);

/** POSTED cell: "12 Jun 2026" / "12 giu 2026"; "—" for a date that can't be read. */
export const formatPosted = (iso: string, language: string): string => formatShortDate(iso, language) ?? '—';

/** Full counts in the stat cells: "24,120" / "24.120". */
export const formatCount = (n: number, language: string) => new Intl.NumberFormat(intlLocale(language)).format(n);

/** First letter of a name for the avatar circle ("Kessler_Wolf" → "K"). */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}
