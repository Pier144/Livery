import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSettings } from '@/queries/settings';
import { useAtelierUi } from '@/store/atelier';
import { AtelierHome } from './Atelier/AtelierHome';
import { hasWebGL2 } from './Atelier/webgl';
import { openSettingsAt } from './Settings/settingsUi';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/**
 * The editor loads when a project opens, in its own chunk: three.js and the bake stay out of the
 * start-up bundle and out of the Atelier home.
 */
const Editor = lazy(() => import('./Atelier/Editor').then((m) => ({ default: m.Editor })));

/**
 * Atelier, the skin editor (Settings → Experimental → Atelier): the project grid, or the editor of
 * the open project. It reads the vehicles' models from the game, so with Settings → Game → Read
 * data from the game off it explains that and links there; without WebGL 2 it explains that and
 * stays closed.
 */
export function Atelier() {
  const { t } = useTranslation();
  const settings = useSettings().data;
  const openProjectId = useAtelierUi((s) => s.openProjectId);
  const [webgl] = useState(hasWebGL2);

  if (settings && !settings.readGameData) {
    return (
      <Gate
        title={t('atelier.gate.gameDataTitle')}
        body={t('atelier.gate.gameDataBody')}
        primary={{ label: t('atelier.gate.openGame'), onClick: () => openSettingsAt('game') }}
      />
    );
  }
  if (!webgl) return <Gate title={t('atelier.gate.webglTitle')} body={t('atelier.gate.webglBody')} />;

  if (openProjectId) {
    return (
      <Suspense fallback={<EditorSkeleton />}>
        <Editor key={openProjectId} id={openProjectId} />
      </Suspense>
    );
  }
  return <AtelierHome />;
}

/** Atelier can't open: the screen's heading and why. */
function Gate({ title, body, primary }: { title: string; body: string; primary?: { label: string; onClick: () => void } }) {
  const { t } = useTranslation();
  return (
    <ScreenFrame label={t('common.nav.atelier')}>
      <ScreenHeader title={t('common.nav.atelier')} />
      <EmptyState title={title} body={body} primary={primary} />
    </ScreenFrame>
  );
}

/** While the editor's chunk loads: its top bar and an empty stage. */
function EditorSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="flex h-full min-h-0 flex-col gap-3.5 px-6 pb-6 pt-4.5">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden className="flex h-7 items-center gap-3">
        <div className="h-3 w-48 rounded-tag bg-bg-skel" />
      </div>
      <Skeleton className="min-h-0 flex-1 rounded-card" />
    </div>
  );
}
