import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { errorText } from '@/lib/errors';
import { useCollections } from '@/queries/collections';
import { useHangar } from '@/queries/hangar';
import { resolveOpenCollection, useCollectionsUi } from '@/store/collections';
import type { Collection, HangarSkin } from '@/types';
import { CollectionDetail, CollectionDetailSkeleton } from './Collections/CollectionDetail';
import { CollectionList } from './Collections/CollectionList';
import { useCollectionActions } from './Collections/useCollectionActions';

const NO_SKINS: HangarSkin[] = [];

/**
 * Collections (README §5): named sets of hangar skins. Activating one makes exactly its skins
 * active in the game; the others stay installed, just inactive. Nothing is deleted.
 */
export function Collections() {
  const { t } = useTranslation();
  const collectionsQuery = useCollections();
  const hangarQuery = useHangar();
  const openId = useCollectionsUi((s) => s.openId);
  const open = useCollectionsUi((s) => s.open);
  const actions = useCollectionActions();
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  // A collection deleted from the detail while focus was there: once it is gone, focus the card
  // that opened in its place (or "New collection" when none is left).
  const [focusAfterDelete, setFocusAfterDelete] = useState<string | null>(null);

  const state = collectionsQuery.data;
  const hangar = hangarQuery.data ?? NO_SKINS;

  // Members are the collection's skins found in My Hangar, in collection order.
  const members = useMemo(() => {
    const byId = new Map(hangar.map((s) => [s.id, s]));
    return (c: Collection) => c.skinIds.flatMap((id) => byId.get(id) ?? []);
  }, [hangar]);
  const counts = useMemo(
    () => new Map((state?.collections ?? []).map((c) => [c.id, members(c).length])),
    [state, members],
  );

  useEffect(() => {
    if (!focusAfterDelete || state?.collections.some((c) => c.id === focusAfterDelete)) return;
    setFocusAfterDelete(null);
    const target =
      listRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ??
      emptyRef.current?.querySelector<HTMLElement>('button');
    target?.focus();
  }, [focusAfterDelete, state]);

  if (collectionsQuery.isError || hangarQuery.isError) {
    const error = collectionsQuery.error ?? hangarQuery.error;
    return (
      <section aria-label={t('collections.title')} className="flex h-full flex-col">
        <h1 tabIndex={-1} className="sr-only">
          {t('collections.title')}
        </h1>
        <EmptyState
          title={t('collections.loadFailed')}
          body={error ? errorText(error, t) : undefined}
          primary={{
            label: t('common.retry'),
            onClick: () => {
              void collectionsQuery.refetch();
              void hangarQuery.refetch();
            },
          }}
        />
      </section>
    );
  }

  const loading = !state || hangarQuery.isPending;

  if (!loading && state.collections.length === 0) {
    return (
      <section aria-label={t('collections.title')} className="flex h-full flex-col">
        <h1 tabIndex={-1} className="sr-only">
          {t('collections.title')}
        </h1>
        <div ref={emptyRef} className="flex flex-1">
          <EmptyState
            title={t('collections.emptyTitle')}
            body={t('collections.helper')}
            primary={{ label: t('collections.newCollection'), onClick: () => void actions.createAndRename() }}
          />
        </div>
      </section>
    );
  }

  const current = loading ? undefined : resolveOpenCollection(state, openId);

  return (
    <section
      aria-label={t('collections.title')}
      className="grid h-full grid-cols-[340px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden"
    >
      <CollectionList
        ref={listRef}
        collections={loading ? undefined : state.collections}
        activeId={state?.activeCollectionId}
        openId={current?.id}
        counts={counts}
        onOpen={open}
        onNew={() => void actions.createAndRename()}
        creating={actions.creating}
      />
      {current ? (
        <CollectionDetail
          key={current.id}
          collection={current}
          members={members(current)}
          active={current.id === state?.activeCollectionId}
          actions={actions}
          onDeleted={() => setFocusAfterDelete(current.id)}
        />
      ) : (
        <CollectionDetailSkeleton />
      )}
    </section>
  );
}
