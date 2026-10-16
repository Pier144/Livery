// PLACEHOLDER (Task 18): the open project's name and a way back to the projects. Task 21 replaces
// this file with the real editor (`Editor.tsx`, lazily loaded by `src/screens/Atelier.tsx`).

import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAtelierProject } from '@/queries/atelier';
import { useVehicles, useVehicleNames } from '@/queries/vehicles';
import { useAtelierUi } from '@/store/atelier';
import { vehicleLabel } from '../Explore/exploreModel';

export function EditorPlaceholder({ id }: { id: string }) {
  const { t } = useTranslation();
  const close = useAtelierUi((s) => s.close);
  const project = useAtelierProject(id).data;
  const vehicles = useVehicles();
  const names = useVehicleNames();
  return (
    <section aria-label={project?.name ?? t('common.nav.atelier')} className="flex h-full min-h-0 flex-col gap-3.5 px-6 pt-4.5">
      <div className="flex items-center gap-3 border-b border-line-2 pb-2.5">
        <button
          type="button"
          onClick={close}
          aria-label={t('atelier.editor.back')}
          title={t('atelier.editor.back')}
          className="grid h-7 w-7 flex-none place-items-center rounded-ctl text-ink-3 hover:bg-bg-hover hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
        </button>
        {project ? (
          <>
            <h1 tabIndex={-1} className="min-w-0 truncate text-card outline-none">
              {project.name}
            </h1>
            <span className="min-w-0 truncate text-meta text-ink-3">{vehicleLabel(vehicles, project.vehicle, names)}</span>
          </>
        ) : (
          <div aria-hidden className="h-3 w-40 rounded-tag bg-bg-skel" />
        )}
      </div>
    </section>
  );
}
