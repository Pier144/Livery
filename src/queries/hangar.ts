import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, hasBackend } from '@/lib/tauri';
import type { AppError, DeleteResult, ExportResult, HangarSkin } from '@/types';

export interface HangarSummary {
  count: number;
  sizeBytes: number;
}

/** Invalidate after anything that changes the index (import, install, delete…). */
export const HANGAR_KEY = ['hangar'] as const;

const NONE: HangarSkin[] = [];

/** Skins in My Hangar (`get_hangar`, from the library index). Empty outside Tauri. */
export function useHangar() {
  return useQuery<HangarSkin[], AppError>({
    queryKey: HANGAR_KEY,
    queryFn: () => (hasBackend() ? call<HangarSkin[]>('get_hangar') : Promise.resolve(NONE)),
  });
}

/** Installed-skin count and total size on disk (sidebar status card). Zero while loading. */
export function useHangarSummary(): HangarSummary {
  const { data = NONE } = useHangar();
  return { count: data.length, sizeBytes: data.reduce((sum, s) => sum + s.sizeBytes, 0) };
}

/** Full rescan of UserSkins with attention checks ("Re-check"); refreshes the index. */
export function useRescan() {
  const qc = useQueryClient();
  return useMutation<HangarSkin[], AppError, void>({
    mutationFn: () => call<HangarSkin[]>('scan_user_skins'),
    onSuccess: () => qc.invalidateQueries({ queryKey: HANGAR_KEY }),
  });
}

/** Activates/deactivates skins; the backend returns the whole index. */
export function useSetSkinActive() {
  const qc = useQueryClient();
  return useMutation<HangarSkin[], AppError, { ids: string[]; active: boolean }>({
    mutationFn: ({ ids, active }) => call<HangarSkin[]>('set_skin_active', { ids, active }),
    onSuccess: (index) => qc.setQueryData(HANGAR_KEY, index),
    // A conflict/io error can come after the other skins already moved: re-read the index.
    onError: () => qc.invalidateQueries({ queryKey: HANGAR_KEY }),
  });
}

/** Deletes skins with a backup each; undo with `useRestoreBackups`. */
export function useDeleteSkins() {
  const qc = useQueryClient();
  return useMutation<DeleteResult, AppError, string[]>({
    mutationFn: (ids) => call<DeleteResult>('delete_skins', { ids }),
    onSettled: () => qc.invalidateQueries({ queryKey: HANGAR_KEY }),
  });
}

/** Undo for a delete (or a replace): puts the backed-up folders back. */
export function useRestoreBackups() {
  const qc = useQueryClient();
  return useMutation<HangarSkin[], AppError, string[]>({
    mutationFn: (backupIds) => call<HangarSkin[]>('restore_backups', { backupIds }),
    onSettled: () => qc.invalidateQueries({ queryKey: HANGAR_KEY }),
  });
}

/** Copies skin folders into a folder the user picked. */
export function useExportSkins() {
  return useMutation<ExportResult, AppError, { ids: string[]; dest: string }>({
    mutationFn: ({ ids, dest }) => call<ExportResult>('export_skins', { ids, dest }),
  });
}
