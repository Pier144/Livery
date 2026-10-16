import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { parseModelBuffer, type VehicleModelData } from '@/atelier/modelBuffer';
import { errorText } from '@/lib/errors';
import { call, callRaw, hasBackend, toAppError } from '@/lib/tauri';
import { toast } from '@/store/toasts';
import type { AppError, AtelierProject, AtelierProjectSummary } from '@/types';

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

/**
 * Deletes a project into the backend's trash, then shows an undoable toast: Undo brings it back
 * (`atelier_project_undo_delete`), the toast leaving without Undo removes it for good
 * (`atelier_project_forget_deleted`).
 */
export function useDeleteProject() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useMutation<null, AppError, { id: string; name: string }>({
    mutationFn: ({ id }) => call<null>('atelier_project_delete', { id }),
    onSuccess: (_, { id, name }) => {
      qc.removeQueries({ queryKey: atelierProjectKey(id) });
      toast.undoable(
        t('atelier.toast.deleted', { name }),
        async () => {
          try {
            await call('atelier_project_undo_delete', { id });
          } catch (e) {
            toast(errorText(toAppError(e), t));
          } finally {
            await qc.invalidateQueries({ queryKey: ATELIER_PROJECTS_KEY });
          }
        },
        async () => {
          qc.removeQueries({ queryKey: thumbKey(id) });
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
