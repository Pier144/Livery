import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { useJustEntered } from '@/lib/motion';
import { call, toAppError } from '@/lib/tauri';
import { atelierProjectKey, installedSkinOf, useAtelierProjects, useDeleteProject, useDuplicateProject, useSaveProject } from '@/queries/atelier';
import { useVehicleNames, useVehicles } from '@/queries/vehicles';
import { useAtelierUi } from '@/store/atelier';
import { confirmWithOption } from '@/store/confirm';
import { toast } from '@/store/toasts';
import type { AtelierProject, AtelierProjectSummary } from '@/types';
import { vehicleLabel } from '../Explore/exploreModel';
import { ScreenFrame, ScreenHeader } from '../ScreenHeader';
import { NewProjectDialog } from './NewProjectDialog';
import { ProjectCard } from './ProjectCard';

/**
 * Atelier home: the user's projects as a grid of cards (newest edit first) and "New project". A
 * card opens its project in the editor; its menu renames it in place, duplicates it or deletes it
 * (after a confirmation that can also uninstall the skin it installed; undoable from the toast: the
 * backend keeps it in a trash until the toast leaves).
 */
export function AtelierHome() {
  const { t } = useTranslation();
  const query = useAtelierProjects();
  const openProject = useAtelierUi((s) => s.open);
  const vehicles = useVehicles();
  const names = useVehicleNames();
  const actions = useProjectActions();
  const hintId = useId();
  const newRef = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);

  const projects = query.data;
  const loaded = projects !== undefined;
  // The grid replaced its skeleton: it fades in (not when the home opens with the list already known).
  const justLoaded = useJustEntered(loaded);

  const onOpen = useCallback((p: AtelierProjectSummary) => openProject(p.id), [openProject]);

  // Deleting from a card: focus moves to the next card (the previous one at the end, else "New project").
  const order = useRef<string[]>([]);
  order.current = projects?.map((p) => p.id) ?? [];
  const { remove } = actions;
  const onDelete = useCallback(
    (p: AtelierProjectSummary) => {
      const ids = order.current;
      const at = ids.indexOf(p.id);
      const neighbour = ids[at + 1] ?? ids[at - 1];
      const hadFocus = !!document.activeElement?.closest(`[data-project-id="${CSS.escape(p.id)}"]`);
      void remove(p).then((removed) => {
        if (!removed || !hadFocus) return;
        requestAnimationFrame(() => {
          const next = neighbour ? document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(neighbour)}"] [role="button"]`) : null;
          (next ?? newRef.current)?.focus();
        });
      });
    },
    [remove],
  );

  const newButton = (
    <Button ref={newRef} variant="primary" size={28} onClick={() => setCreating(true)}>
      <Plus size={14} strokeWidth={1.75} aria-hidden />
      {t('atelier.home.newProject')}
    </Button>
  );

  const empty = loaded && projects.length === 0;

  return (
    <ScreenFrame label={t('common.nav.atelier')}>
      <ScreenHeader
        title={t('common.nav.atelier')}
        meta={loaded && !empty ? t('atelier.home.count', { count: projects.length }) : undefined}
        right={loaded && !empty ? newButton : undefined}
      />
      {empty ? (
        <EmptyState
          title={t('atelier.home.emptyTitle')}
          body={t('atelier.home.emptyBody')}
          primary={{ label: t('atelier.home.newProject'), onClick: () => setCreating(true) }}
        />
      ) : !loaded ? (
        query.isError ? (
          <EmptyState
            title={t('atelier.home.loadErrorTitle')}
            body={errorText(query.error, t)}
            primary={{ label: t('common.retry'), onClick: () => void query.refetch() }}
          />
        ) : (
          <HomeSkeleton />
        )
      ) : (
        <div
          role="region"
          aria-label={t('atelier.home.projects')}
          // Pulled out by 4px and padded back, so the cards' focus ring isn't clipped.
          className={cn('-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-6 pt-1', justLoaded && 'motion-safe:animate-image-in')}
        >
          <span id={hintId} hidden>
            {t('atelier.card.hint')}
          </span>
          <ul className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {projects.map((p) => (
              <li key={p.id} className="min-w-0">
                <ProjectCard
                  project={p}
                  vehicleLabel={vehicleLabel(vehicles, p.vehicle, names)}
                  hintId={hintId}
                  onOpen={onOpen}
                  onRename={actions.rename}
                  onDuplicate={actions.duplicate}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(project: AtelierProject) => {
            setCreating(false);
            openProject(project.id);
          }}
        />
      )}
    </ScreenFrame>
  );
}

/** Rename, duplicate and delete, with their toasts. Callbacks are stable (the cards are memoized). */
function useProjectActions() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { mutateAsync: save } = useSaveProject();
  const { mutateAsync: duplicateProject } = useDuplicateProject();
  const { mutateAsync: deleteProject } = useDeleteProject();

  const report = useCallback((e: unknown) => toast(errorText(toAppError(e), t)), [t]);

  /** Saves the stored project under a new name (read fresh: the cached copy may be older). */
  const saveName = useCallback(
    async (id: string, name: string) => {
      const stored = await qc.fetchQuery({
        queryKey: atelierProjectKey(id),
        queryFn: () => call<AtelierProject>('atelier_project_get', { id }),
        staleTime: 0,
      });
      await save({ ...stored, name });
    },
    [qc, save],
  );

  const rename = useCallback(
    async (p: AtelierProjectSummary, name: string): Promise<boolean> => {
      try {
        await saveName(p.id, name);
      } catch (e) {
        report(e);
        return false;
      }
      toast.undoable(t('atelier.toast.renamed', { name }), async () => {
        try {
          await saveName(p.id, p.name);
        } catch (e) {
          report(e);
        }
      });
      return true;
    },
    [saveName, report, t],
  );

  const duplicate = useCallback(
    (p: AtelierProjectSummary) => {
      duplicateProject(p.id).catch(report);
    },
    [duplicateProject, report],
  );

  /**
   * Asks first; when the project's skin is still in My Hangar the question offers to uninstall it
   * too (unchecked). Resolves to whether the project went to the trash.
   */
  const asking = useRef(new Set<string>());
  const remove = useCallback(
    async (p: AtelierProjectSummary): Promise<boolean> => {
      if (asking.current.has(p.id)) return false;
      asking.current.add(p.id);
      let answer;
      let skin = null;
      try {
        // Not knowing the skin (an unreadable project, no game) only leaves the option out.
        skin = await installedSkinOf(qc, p.id).catch(() => null);
        answer = await confirmWithOption({
          title: t('atelier.confirm.deleteTitle', { name: p.name }),
          body: t('atelier.confirm.deleteBody'),
          confirmLabel: t('atelier.confirm.delete'),
          option: skin ? t('atelier.confirm.alsoSkin', { name: skin.name }) : undefined,
        });
      } finally {
        asking.current.delete(p.id);
      }
      if (!answer.ok) return false;
      try {
        await deleteProject({ id: p.id, name: p.name, skin: skin && answer.checked ? { id: skin.id, name: skin.name } : undefined });
        return true;
      } catch (e) {
        report(e);
        return false;
      }
    },
    [qc, deleteProject, report, t],
  );

  return { rename, duplicate, remove };
}

/** Loading: eight shimmering cards in the home's grid (minmax 220, gap 12, like My Hangar). */
function HomeSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pt-1">
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: 8 }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
