import { useEffect, useId, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorText } from '@/lib/errors';
import { isOfflineError, useWtLivePost } from '@/queries/wtlive';
import { useDetail, useDetailTry } from '@/store/detail';
import { useExplore } from '@/store/explore';
import { useWtLiveInstall } from '@/store/installs';
import { useUi } from '@/store/ui';
import type { WtLiveSkin } from '@/types';
import { DetailTopBar, type TabIds } from './DetailTopBar';
import { Gallery } from './Gallery';
import { SidePanel } from './SidePanel';
import { TexturesTab } from './TexturesTab';
import { TryInGame } from './TryInGame';
import type { DetailTab } from './detailModel';

/**
 * Skin detail (README §3) for `ui.detailSkinId`: top bar with tabs, then `1fr 320px` — the tab on
 * the left (Gallery / Textures / Try in game), the side panel on the right; each column scrolls.
 * Loading → skeletons; WT Live unreachable → the offline state (the library keeps working).
 */
export function SkinDetail() {
  const { t } = useTranslation();
  const id = useUi((s) => s.detailSkinId);
  const returnTo = useUi((s) => s.detailReturnTo);
  const go = useUi((s) => s.go);
  const post = useWtLivePost(id);

  // The store resets on every entry (see src/store/detail.ts); this covers a mount with another id.
  useLayoutEffect(() => {
    if (useDetail.getState().skinId !== id) useDetail.getState().reset(id);
  }, [id]);
  useEscapeLayers();

  if (id === null) {
    return (
      <Frame>
        <EmptyState
          title={t('detail.noSkin.title')}
          body={t('detail.noSkin.body')}
          primary={{ label: t(`detail.backTo.${returnTo}`), onClick: () => go(returnTo) }}
        />
      </Frame>
    );
  }

  if (post.data) return <LoadedDetail skin={post.data} />;

  if (post.isError) {
    const offline = isOfflineError(post.error);
    return (
      <Frame>
        <EmptyState
          dot={offline}
          title={offline ? t('detail.offline.title') : t('detail.error.title')}
          body={offline ? t('detail.offline.body') : errorText(post.error, t)}
          primary={offline ? { label: t('detail.offline.hangar'), onClick: () => go('hangar') } : undefined}
          secondary={{ label: t('common.retry'), onClick: () => void post.refetch() }}
        />
      </Frame>
    );
  }

  return <DetailSkeleton />;
}

/** Top bar with only the back button (loading, offline, errors) above the given content. */
function Frame({ children, placeholder }: { children: ReactNode; placeholder?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailTopBar placeholder={placeholder} />
      {children}
    </div>
  );
}

function LoadedDetail({ skin }: { skin: WtLiveSkin }) {
  const baseId = useId();
  const go = useUi((s) => s.go);
  const tab = useDetail((s) => s.tab);
  const setTab = useDetail((s) => s.setTab);
  const settleTab = useDetail((s) => s.settleTab);
  const tryInfo = useDetailTry(skin.id);
  const install = useWtLiveInstall(skin);

  // A skin being tried in game opens on Try in game (coming back from Explore lands on Keep/Discard).
  const trying = tryInfo.state === 'active' || tryInfo.state === 'installing';
  useLayoutEffect(() => {
    if (tryInfo.hangarKnown) settleTab(trying);
  }, [skin.id, tryInfo.hangarKnown, trying, settleTab]);

  const ids = useMemo<TabIds>(
    () => ({ tab: (k: DetailTab) => `${baseId}-tab-${k}`, panel: (k: DetailTab) => `${baseId}-panel-${k}` }),
    [baseId],
  );

  // Explore showing exactly this vehicle's skins (Explore owns its filters).
  const openVehicle = () => {
    useExplore.getState().applyVehicle(skin.vehicle.code);
    go('explore');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailTopBar skin={{ name: skin.name, code: skin.vehicle.code }} tabs={{ active: tab, ids, onSelect: setTab }} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
        <div
          role="tabpanel"
          id={ids.panel(tab)}
          aria-labelledby={ids.tab(tab)}
          // Focusable so its content can be scrolled from the keyboard (the textures table has no controls).
          tabIndex={0}
          className="flex min-h-0 min-w-0 flex-col overflow-y-auto focus-visible:-outline-offset-2"
        >
          {tab === 'gallery' && <Gallery skin={skin} />}
          {tab === 'textures' && <TexturesTab skin={skin} hangarSkin={tryInfo.hangarSkin} />}
          {tab === 'try' && <TryInGame skin={skin} state={tryInfo.state} hangarSkin={tryInfo.hangarSkin} track={tryInfo.track} />}
        </div>
        <SidePanel
          skin={skin}
          hangarSkin={tryInfo.hangarSkin}
          install={{ state: install.state, start: install.install }}
          track={tryInfo.track}
          onOpenVehicle={openVehicle}
          onOpenTry={() => setTab('try')}
        />
      </div>
    </div>
  );
}

function DetailSkeleton() {
  const { t } = useTranslation();
  return (
    <Frame placeholder={<Skeleton className="h-4 w-[220px] rounded-tag" />}>
      <div role="status" aria-busy="true" className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
        <span className="sr-only">{t('detail.loading')}</span>
        <div aria-hidden className="flex min-h-0 flex-col gap-3 px-6 py-5">
          <Skeleton className="min-h-[200px] flex-1 rounded-card" />
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[68px] w-[120px] rounded-ctl" />
            ))}
          </div>
        </div>
        <div aria-hidden className="flex min-h-0 flex-col gap-4.5 border-l border-line-2 bg-bg-1 p-5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-[34px] w-[34px] rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="h-3 w-[60%] rounded-tag bg-bg-skel" />
              <div className="h-2.5 w-[35%] rounded-tag bg-bg-4" />
            </div>
          </div>
          <Skeleton className="h-[52px] rounded-ctl" />
          <Skeleton className="h-[112px] rounded-ctl" />
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-2.5 w-[70%] rounded-tag bg-bg-4" />
            ))}
          </div>
          <div className="flex-1" />
          <div className="h-btn-lg rounded-ctl bg-bg-hover" />
          <div className="h-8 rounded-ctl bg-bg-hover" />
        </div>
      </div>
    </Frame>
  );
}

/**
 * Escape closes only the topmost layer: open menus and dialogs stop it themselves; the palette
 * owns it while open; otherwise zoom goes first, then compare (one per press).
 */
function useEscapeLayers() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || useUi.getState().palette.open) return;
      if (useDetail.getState().escape()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
