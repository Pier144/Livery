import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { parseModelBuffer, type VehicleModelData } from '@/atelier/modelBuffer';
import { errorText } from '@/lib/errors';
import { call, callRaw, hasBackend, toAppError } from '@/lib/tauri';
import { HANGAR_KEY } from '@/queries/hangar';
import { BACKUPS_KEY } from '@/queries/settings';
import { toast } from '@/store/toasts';
import type { FontRef } from '@/atelier/project';
import type {
  AppError,
  AssetRef,
  AtelierProject,
  AtelierProjectSummary,
  CutoutResult,
  CutoutStatus,
  DeleteResult,
  FontInfo,
  HangarSkin,
} from '@/types';

/** Everything Atelier caches (projects, models, templates, thumbnails). */
export const ATELIER_KEY = ['atelier'] as const;
/** `atelier_projects`: invalidate after anything that changes the list (create, save, delete…). */
export const ATELIER_PROJECTS_KEY = ['atelier', 'projects'] as const;
export const atelierProjectKey = (id: string) => ['atelier', 'project', id] as const;
export const vehicleModelKey = (vehicle: string) => ['atelier', 'model', vehicle] as const;
export const templateTextureKey = (vehicle: string, slot: string) => ['atelier', 'template', vehicle, slot] as const;
export const thumbKey = (id: string) => ['atelier', 'thumb', id] as const;

const NONE: AtelierProjectSummary[] = [];

/** The Atelier home's projects, most recently saved first. Empty when nothing answers commands. */
export function useAtelierProjects() {
  return useQuery<AtelierProjectSummary[], AppError>({
    queryKey: ATELIER_PROJECTS_KEY,
    queryFn: () => (hasBackend() ? call<AtelierProjectSummary[]>('atelier_projects') : Promise.resolve(NONE)),
  });
}

/**
 * One project, as stored. Read once per editor session: the editor's store owns the project
 * while it is open (autosaves write the saved copy back here, never refetch it).
 */
export function useAtelierProject(id: string | null) {
  return useQuery<AtelierProject, AppError>({
    queryKey: atelierProjectKey(id ?? ''),
    queryFn: () => call<AtelierProject>('atelier_project_get', { id }),
    enabled: id !== null && hasBackend(),
    staleTime: Infinity,
  });
}

/** A new project for a vehicle; the backend reads the vehicle's model first (its slots), so it fails when the model can't be read. */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation<AtelierProject, AppError, { name: string; vehicle: string }>({
    mutationFn: ({ name, vehicle }) => call<AtelierProject>('atelier_project_create', { name, vehicle }),
    onSuccess: (project) => {
      qc.setQueryData(atelierProjectKey(project.id), project);
      return qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY });
    },
  });
}

/**
 * Saves a project (autosave, rename). The saved copy replaces the cached project without a
 * refetch (the editor is the source of truth while open); the list is invalidated (name, date).
 */
export function useSaveProject() {
  const qc = useQueryClient();
  return useMutation<AtelierProject, AppError, AtelierProject>({
    mutationFn: (project) => call<AtelierProject>('atelier_project_save', { project }),
    onSuccess: (saved) => {
      qc.setQueryData(atelierProjectKey(saved.id), saved);
      return qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY });
    },
  });
}

/** A copy of a project under a free name (`<name> (2)`), without its installed skin. */
export function useDuplicateProject() {
  const qc = useQueryClient();
  return useMutation<AtelierProject, AppError, string>({
    mutationFn: (id) => call<AtelierProject>('atelier_project_duplicate', { id }),
    onSuccess: (copy) => {
      qc.setQueryData(atelierProjectKey(copy.id), copy);
      return qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY });
    },
  });
}

/** The skin the project's last apply installed, while it is still in My Hangar (null otherwise). */
export async function installedSkinOf(qc: QueryClient, id: string): Promise<HangarSkin | null> {
  const project = await qc.fetchQuery({
    queryKey: atelierProjectKey(id),
    queryFn: () => call<AtelierProject>('atelier_project_get', { id }),
    staleTime: 0,
  });
  const skinId = project.installedSkinId;
  if (!skinId) return null;
  const skins = await qc.fetchQuery({ queryKey: HANGAR_KEY, queryFn: () => call<HangarSkin[]>('get_hangar'), staleTime: 0 });
  return skins.find((s) => s.id === skinId && !s.temporary) ?? null;
}

/**
 * Deletes a project into the backend's trash and, with `skin`, uninstalls that skin too (with a
 * backup, like My Hangar), then shows one undoable toast: Undo brings both back
 * (`atelier_project_undo_delete`, `restore_backups`), the toast leaving without Undo removes them for
 * good (`atelier_project_forget_deleted`, `clear_backups`). A skin that can't be uninstalled is
 * reported and the project's delete stands.
 */
export function useDeleteProject() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useMutation<string[] | null, AppError, { id: string; name: string; skin?: { id: string; name: string } }>({
    mutationFn: async ({ id, skin }) => {
      await call<null>('atelier_project_delete', { id });
      if (!skin) return null;
      try {
        return (await call<DeleteResult>('delete_skins', { ids: [skin.id] })).backupIds;
      } catch (e) {
        toast(errorText(toAppError(e), t));
        return null;
      } finally {
        void qc.invalidateQueries({ queryKey: HANGAR_KEY });
      }
    },
    onSuccess: (backupIds, { id, name }) => {
      qc.removeQueries({ queryKey: atelierProjectKey(id) });
      const skinGone = backupIds !== null;
      const backups = backupIds ?? [];
      toast.undoable(
        t(skinGone ? 'atelier.toast.deletedWithSkin' : 'atelier.toast.deleted', { name }),
        async () => {
          try {
            await call('atelier_project_undo_delete', { id });
          } catch (e) {
            toast(errorText(toAppError(e), t));
          }
          if (backups.length > 0) {
            try {
              await call('restore_backups', { backupIds: backups });
            } catch (e) {
              toast(errorText(toAppError(e), t));
            }
          }
          await Promise.all([
            qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY }),
            backups.length > 0 ? qc.invalidateQueries({ queryKey: HANGAR_KEY }) : null,
          ]);
        },
        async () => {
          qc.removeQueries({ queryKey: thumbKey(id) });
          if (backups.length > 0) {
            // A backup left behind goes with the 30-day expiry.
            call('clear_backups', { ids: backups })
              .catch(() => undefined)
              .finally(() => void qc.invalidateQueries({ queryKey: BACKUPS_KEY }));
          }
          await call('atelier_project_forget_deleted', { id });
        },
      );
      return qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY });
    },
  });
}

/**
 * The vehicle's paintable model (`atelier_model`, the `LVM1` binary), parsed. Read once per
 * vehicle: the backend caches it per game version too.
 */
export function useVehicleModel(vehicle: string | null) {
  return useQuery<VehicleModelData, AppError>({
    queryKey: vehicleModelKey(vehicle ?? ''),
    queryFn: async () => parseModelBuffer(toArrayBuffer(await call<unknown>('atelier_model', { vehicle }))),
    enabled: vehicle !== null && hasBackend(),
    staleTime: Infinity,
  });
}

/** The original texture of one slot, RGBA8 rows top to bottom (its size is in the model's header). */
export function useTemplateTexture(vehicle: string | null, slot: string | null) {
  return useQuery<Uint8Array<ArrayBuffer>, AppError>({
    queryKey: templateTextureKey(vehicle ?? '', slot ?? ''),
    queryFn: async () => new Uint8Array(toArrayBuffer(await call<unknown>('atelier_template_texture', { vehicle, slot }))),
    enabled: vehicle !== null && slot !== null && hasBackend(),
    staleTime: Infinity,
  });
}

/** The original textures of several slots at once (one query each, shared with `useTemplateTexture`). */
export function useTemplateTextures(vehicle: string | null, slots: readonly string[]) {
  return useQueries({
    queries: slots.map((slot) => ({
      queryKey: templateTextureKey(vehicle ?? '', slot),
      queryFn: async () => new Uint8Array(toArrayBuffer(await call<unknown>('atelier_template_texture', { vehicle, slot }))),
      enabled: vehicle !== null && hasBackend(),
      staleTime: Infinity,
    })),
  });
}

/**
 * The bytes of a binary command answer: an `ArrayBuffer` (`tauri::ipc::Response`, the mock), a
 * `Uint8Array`, or a plain number array (Tauri's fallback when the response isn't sent raw).
 * Anything else throws `Error('model buffer: unexpected payload')`.
 */
export function toArrayBuffer(x: unknown): ArrayBuffer {
  if (x instanceof ArrayBuffer) return x;
  if (x instanceof Uint8Array) return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
  if (Array.isArray(x) && x.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(x as number[]).buffer;
  throw new Error('model buffer: unexpected payload');
}

/** A project's thumbnail (PNG bytes), `null` when it has none. */
export function useThumb(id: string, enabled = true) {
  return useQuery<Uint8Array<ArrayBuffer> | null, AppError>({
    queryKey: thumbKey(id),
    queryFn: async () => {
      const png = new Uint8Array(toArrayBuffer(await call<unknown>('atelier_project_thumb_get', { id })));
      return png.length > 0 ? png : null;
    },
    enabled: enabled && hasBackend(),
    staleTime: Infinity,
  });
}

/** Stores a project's thumbnail (a PNG, sent as the raw request body). */
export function useSetThumb() {
  const qc = useQueryClient();
  return useMutation<null, AppError, { id: string; png: Uint8Array }>({
    mutationFn: ({ id, png }) => callRaw<null>('atelier_project_thumb', png, { 'x-project-id': id }),
    onSuccess: (_, { id }) =>
      Promise.all([qc.invalidateQueries({ queryKey: thumbKey(id) }), qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY })]),
  });
}

// ── Pictures, fonts, background removal (Phase 2) ───────────────────────────

/** The backend's command names for pictures, fonts and background removal (a rename is one line here). */
export const ATELIER_CMD = {
  importImage: 'atelier_import_image',
  asset: 'atelier_asset',
  assetPut: 'atelier_asset_put',
  projectOpen: 'atelier_project_open',
  fonts: 'atelier_fonts',
  fontFile: 'atelier_font_file',
  cutoutStatus: 'atelier_cutout_status',
  cutoutDownload: 'atelier_cutout_download',
  cutoutCancel: 'atelier_cutout_cancel',
  cutoutRemove: 'atelier_cutout_remove',
  cutout: 'atelier_cutout',
} as const;

export const atelierAssetKey = (projectId: string, assetId: string) => ['atelier', 'asset', projectId, assetId] as const;
export const ATELIER_FONTS_KEY = ['atelier', 'fonts'] as const;
export const fontFileKey = (font: FontRef) => ['atelier', 'font', font.family, font.style] as const;
export const CUTOUT_STATUS_KEY = ['atelier', 'cutout-status'] as const;

/** A picture as RGBA8 rows top to bottom, straight alpha. */
export interface RawPicture {
  width: number;
  height: number;
  rgba: Uint8Array<ArrayBuffer>;
}

/** Bytes before the pixels in `atelier_asset`'s answer: `u32` width and height, little-endian. */
export const ASSET_HEADER_BYTES = 8;

/** `atelier_asset`'s answer read; throws `Error('asset: …')` when its length doesn't match its size. */
export function parseAssetBuffer(buf: ArrayBuffer): RawPicture {
  if (buf.byteLength < ASSET_HEADER_BYTES) throw new Error(`asset: ${buf.byteLength} bytes`);
  const view = new DataView(buf);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (width === 0 || height === 0 || buf.byteLength !== ASSET_HEADER_BYTES + width * height * 4) {
    throw new Error(`asset: ${width}x${height} in ${buf.byteLength} bytes`);
  }
  return { width, height, rgba: new Uint8Array(buf, ASSET_HEADER_BYTES) };
}

/** Imports a picture the user picked (a local absolute path) into the project's assets. */
export function importImage(projectId: string, path: string): Promise<AssetRef> {
  return call<AssetRef>(ATELIER_CMD.importImage, { projectId, path });
}

/** A picture of the project, as raw RGBA (never through PNG in the webview: colour under alpha 0 stays). */
export async function fetchAsset(projectId: string, assetId: string): Promise<RawPicture> {
  return parseAssetBuffer(toArrayBuffer(await call<unknown>(ATELIER_CMD.asset, { projectId, assetId })));
}

/** Stores raw RGBA pixels as a new picture of the project (Refine edge); sides up to 4096. */
export function putAsset(projectId: string, picture: RawPicture): Promise<AssetRef> {
  return callRaw<AssetRef>(ATELIER_CMD.assetPut, picture.rgba, {
    'x-project-id': projectId,
    'x-width': String(picture.width),
    'x-height': String(picture.height),
  });
}

/** The editor opened the project (history empty): the backend drops pictures nothing uses. */
export async function openProjectAssets(projectId: string): Promise<void> {
  await call<null>(ATELIER_CMD.projectOpen, { projectId });
}

/** The installed fonts (read again on every call). */
export function fetchFonts(): Promise<FontInfo[]> {
  return call<FontInfo[]>(ATELIER_CMD.fonts);
}

/** The bytes of an installed font (for `new FontFace`). */
export async function fetchFontFile(font: FontRef): Promise<ArrayBuffer> {
  return toArrayBuffer(await call<unknown>(ATELIER_CMD.fontFile, { family: font.family, style: font.style }));
}

export function fetchCutoutStatus(): Promise<CutoutStatus> {
  return call<CutoutStatus>(ATELIER_CMD.cutoutStatus);
}

/** Downloads what background removal still needs (progress on `atelier://download-progress`); the status after. */
export function downloadCutoutFiles(): Promise<CutoutStatus> {
  return call<CutoutStatus>(ATELIER_CMD.cutoutDownload);
}

/** Cancels the running download or cutout, whichever runs (it then fails with its cancelled error). */
export async function cancelCutoutWork(): Promise<void> {
  await call<null>(ATELIER_CMD.cutoutCancel);
}

export function removeCutoutFiles(): Promise<CutoutStatus> {
  return call<CutoutStatus>(ATELIER_CMD.cutoutRemove);
}

/** Removes the background of a picture into a new asset (progress on `atelier://cutout-progress`); the original stays. */
export function cutoutAsset(projectId: string, assetId: string): Promise<CutoutResult> {
  return call<CutoutResult>(ATELIER_CMD.cutout, { projectId, assetId });
}

export function useImportImage() {
  return useMutation<AssetRef, AppError, { projectId: string; path: string }>({
    mutationFn: ({ projectId, path }) => importImage(projectId, path),
  });
}

/**
 * A picture of the project. Not kept once nothing reads it (`gcTime: 0`): consumers turn it into
 * an ImageBitmap or texture and drop the bytes.
 */
export function useAsset(projectId: string | null, assetId: string | null) {
  return useQuery<RawPicture, AppError>({
    queryKey: atelierAssetKey(projectId ?? '', assetId ?? ''),
    queryFn: () => fetchAsset(projectId ?? '', assetId ?? ''),
    enabled: projectId !== null && assetId !== null && hasBackend(),
    staleTime: Infinity,
    gcTime: 0,
  });
}

export function usePutAsset() {
  return useMutation<AssetRef, AppError, { projectId: string; picture: RawPicture }>({
    mutationFn: ({ projectId, picture }) => putAsset(projectId, picture),
  });
}

/** The installed fonts for the text pickers. */
export function useFonts() {
  return useQuery<FontInfo[], AppError>({
    queryKey: ATELIER_FONTS_KEY,
    queryFn: fetchFonts,
    enabled: hasBackend(),
    staleTime: 60_000,
  });
}

/** A font's bytes; not kept once nothing reads them (`gcTime: 0`, consumers make a FontFace). */
export function useFontFile(font: FontRef | null) {
  return useQuery<ArrayBuffer, AppError>({
    queryKey: fontFileKey(font ?? { family: '', style: '' }),
    queryFn: () => fetchFontFile(font ?? { family: '', style: '' }),
    enabled: font !== null && hasBackend(),
    staleTime: Infinity,
    gcTime: 0,
  });
}

/** Whether the background-removal files are on this PC (Settings and the Remove background flow). */
export function useCutoutStatus(enabled = true) {
  return useQuery<CutoutStatus, AppError>({
    queryKey: CUTOUT_STATUS_KEY,
    queryFn: fetchCutoutStatus,
    enabled: enabled && hasBackend(),
  });
}

/** Downloads the background-removal files: the answer is the new status; after a failure it is read again. */
export function useDownloadCutoutFiles() {
  const qc = useQueryClient();
  return useMutation<CutoutStatus, AppError, void>({
    mutationFn: downloadCutoutFiles,
    onSuccess: (status) => qc.setQueryData(CUTOUT_STATUS_KEY, status),
    onError: () => qc.invalidateQueries({ queryKey: CUTOUT_STATUS_KEY }),
  });
}

/** Removes the background-removal files (Settings); the answer is the new status. */
export function useRemoveCutoutFiles() {
  const qc = useQueryClient();
  return useMutation<CutoutStatus, AppError, void>({
    mutationFn: removeCutoutFiles,
    onSuccess: (status) => qc.setQueryData(CUTOUT_STATUS_KEY, status),
  });
}

export function useCutout() {
  return useMutation<CutoutResult, AppError, { projectId: string; assetId: string }>({
    mutationFn: ({ projectId, assetId }) => cutoutAsset(projectId, assetId),
  });
}
