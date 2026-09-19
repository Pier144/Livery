import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton, SkeletonGrid } from '@/components/ui/Skeleton';
import { isOfflineError, useFollowing, useFollowingNew, useMarkFollowingSeen, useSetFollow } from '@/queries/wtlive';
import { useExplore } from '@/store/explore';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import type { FollowEntry, WtLiveSkin } from '@/types';
import { authorSkinCount, cachedWtLiveSkins, formatPostDate } from './exploreModel';
import { SkinImage } from './SkinCard';

/** New skins of one follow: its vehicle's, or its author's. */
export function newFor(entry: FollowEntry, skins: readonly WtLiveSkin[]): number {
  return skins.filter((s) => (entry.kind === 'vehicle' ? s.vehicle.code === entry.id : s.author.id === entry.id)).length;
}

const followKey = (e: FollowEntry) => `${e.kind}:${e.id}`;

/**
 * Marking seen waits a tick after the tab goes away, so React's StrictMode remount (and a quick
 * remount in general) cancels it instead of zeroing the counts the user is looking at.
 */
let pendingMark: ReturnType<typeof setTimeout> | null = null;

/**
 * Following tab (README §2): followed vehicles and authors on the left (click → Explore filtered
 * by it; × unfollows, undoable), new skins from them on the right (click → Skin detail). Follows
 * are local data, so the list works offline. The "N new" counts reset (`following_mark_seen`)
 * when the user leaves the tab after seeing them — not on opening it, and not when a skin's
 * detail is opened from here (the tab is still there on the way back).
 */
export function Following() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const following = useFollowing();
  const entries = following.data;
  const fresh = useFollowingNew(entries);
  const newSkins = fresh.data ?? [];
  const setFollow = useSetFollow();
  const markSeen = useMarkFollowingSeen();
  const applyVehicle = useExplore((s) => s.applyVehicle);
  const applyAuthor = useExplore((s) => s.applyAuthor);
  const setTab = useExplore((s) => s.setTab);
  const openSkin = useUi((s) => s.openSkin);

  const listLabelId = useId();
  const newTitleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // ── Mark seen on leaving the tab ──
  const shown = useRef(false);
  useEffect(() => {
    if (newSkins.length > 0) shown.current = true;
  }, [newSkins.length]);
  const mark = useRef(markSeen.mutateAsync);
  mark.current = markSeen.mutateAsync;
  useEffect(() => {
    if (pendingMark !== null) {
      clearTimeout(pendingMark);
      pendingMark = null;
    }
    return () => {
      if (!shown.current) return;
      pendingMark = setTimeout(() => {
        pendingMark = null;
        if (useUi.getState().screen === 'detail') return;
        void mark
          .current()
          .catch((e: unknown) => console.error('[livery] following_mark_seen failed', e));
      }, 0);
    };
  }, []);

  // ── Focus after an unfollow: the next card, else the previous, else the empty state ──
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingFocus.current;
    if (at === null) return;
    pendingFocus.current = null;
    const cards = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-follow-card]') ?? [])];
    const next = cards[at] ?? cards[cards.length - 1] ?? rootRef.current?.querySelector<HTMLButtonElement>('button');
    next?.focus();
  }, [entries]);

  const unfollow = (entry: FollowEntry, index: number) => {
    const args = { kind: entry.kind, id: entry.id, name: entry.name };
    // Undo follows again from the old "last seen", so the entry's "N new" comes back exactly.
    const refollow = { ...args, follow: true, lastSeenAt: entry.lastSeenAt };
    // Set first: the list re-renders (and focus moves) as soon as the new list is in the cache.
    pendingFocus.current = index;
    setFollow
      .mutateAsync({ ...args, follow: false })
      .then(() => {
        toast.undoable(t('explore.follow.unfollowed', { name: entry.name }), async () => {
          // A failed Undo would silently lose the follow: say so.
          await setFollow.mutateAsync(refollow).catch(() => toast(t('explore.follow.refollowFailed', { name: entry.name })));
        });
      })
      .catch(() => {
        pendingFocus.current = null;
        toast(t('explore.follow.unfollowFailed', { name: entry.name }));
      });
  };

  const open = (entry: FollowEntry) => (entry.kind === 'vehicle' ? applyVehicle(entry.id) : applyAuthor(entry.name));

  if (following.isPending) {
    return (
      <div aria-busy="true" className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] gap-6">
        <div className="flex flex-col gap-2 pt-7">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[54px] rounded-ctl" />
          ))}
        </div>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div ref={rootRef} className="flex min-h-0 flex-1 pb-6">
        <EmptyState
          title={t('explore.follow.emptyTitle')}
          body={t('explore.follow.emptyBody')}
          primary={{ label: t('explore.follow.browse'), onClick: () => setTab('explore') }}
        />
      </div>
    );
  }

  const cached = cachedWtLiveSkins(qc);
  const sub = (e: FollowEntry) => {
    if (e.kind === 'vehicle') return t('explore.follow.vehicle', { code: e.id });
    const count = authorSkinCount(cached, e.id);
    return count === undefined ? t('explore.follow.author') : t('explore.follow.authorCount', { count });
  };

  return (
    // Pulled out by 4px and padded back: room for focus rings inside the scroll area.
    <div ref={rootRef} className="-mx-1 -mt-1 grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] content-start gap-6 overflow-y-auto px-1 pb-6 pt-1">
      <div className="flex min-w-0 flex-col gap-2">
        <h2 id={listLabelId} className="py-1 font-mono text-mono-label uppercase leading-[normal] text-ink-4">
          {t('explore.follow.label', { count: entries.length })}
        </h2>
        <ul ref={listRef} aria-labelledby={listLabelId} className="flex flex-col gap-2">
          {entries.map((e, i) => {
            const n = newFor(e, newSkins);
            return (
              <li key={followKey(e)} className="relative">
                <button
                  type="button"
                  data-follow-card
                  onClick={() => open(e)}
                  className="flex w-full items-center gap-2.5 rounded-ctl border border-line-2 bg-bg-3 py-2.5 pl-3 pr-10 text-left hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body font-medium leading-[normal] text-ink-1">{e.name}</span>
                    <span className="truncate font-mono text-[10px] leading-[normal] text-ink-4">{sub(e)}</span>
                  </span>
                  {n > 0 && (
                    <span className="flex-none whitespace-nowrap rounded-pill bg-amber px-1.5 py-0.5 font-mono text-[10px] font-medium leading-[normal] text-onAmber">
                      {t('explore.newCount', { count: n })}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t('explore.follow.unfollow', { name: e.name })}
                  title={t('explore.follow.unfollow', { name: e.name })}
                  onClick={() => unfollow(e, i)}
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-menu text-ink-4 hover:bg-bg-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
                >
                  <X size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <section aria-labelledby={newTitleId} className="flex min-w-0 flex-col gap-3">
        <h2 id={newTitleId} className="py-1 font-mono text-mono-label uppercase leading-[normal] text-ink-4">
          {t('explore.follow.newTitle')}
        </h2>
        {fresh.isPending ? (
          <SkeletonGrid count={4} />
        ) : fresh.isError ? (
          <p className="text-body text-ink-3">{isOfflineError(fresh.error) ? t('explore.follow.offline') : t('explore.error.body')}</p>
        ) : newSkins.length === 0 ? (
          <p className="text-body text-ink-3">{t('explore.follow.nothingNew')}</p>
        ) : (
          <div className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
            {newSkins.map((s) => (
              <button
                key={s.id}
                type="button"
                data-skin-id={s.id}
                onClick={() => openSkin(s.id)}
                className="flex min-w-0 flex-col rounded-card border border-line-2 bg-bg-3 text-left hover:border-amber hover:shadow-card motion-safe:transition-[border-color,box-shadow] motion-safe:duration-120"
              >
                <SkinImage skin={{ ...s, isNew: true }} showCategory={false} />
                <span className="flex min-w-0 flex-col gap-1.5 p-3">
                  <span className="truncate text-card text-ink-1">{s.name}</span>
                  <span className="text-meta leading-[normal] text-ink-3">
                    <Trans
                      i18nKey="explore.follow.newMeta"
                      values={{ vehicle: s.vehicle.name, author: s.author.name, date: formatPostDate(s.postedAt, i18n.language) }}
                      components={{ author: <span className="text-ink-2" /> }}
                    />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
