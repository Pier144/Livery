import { Check } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatBytes } from '@/lib/format';
import { useCollectionsUi } from '@/store/collections';
import { useUi } from '@/store/ui';
import type { Collection, HangarSkin } from '@/types';
import { InlineInput, InlineTextArea } from './InlineField';
import { MemberCard } from './MemberCard';
import type { CollectionActions } from './useCollectionActions';

interface CollectionDetailProps {
  collection: Collection;
  /** Its skins that are in My Hangar, in collection order (ids missing from the hangar are hidden). */
  members: HangarSkin[];
  /** The collection in use in the game. */
  active: boolean;
  actions: CollectionActions;
  /** After a delete that started from inside this pane (focus would otherwise drop to <body>). */
  onDeleted: () => void;
}

/** Right pane: editable name/description, totals, Activate / Delete, member grid. */
export function CollectionDetail({ collection, members, active, actions, onDeleted }: CollectionDetailProps) {
  const { t } = useTranslation();
  const go = useUi((s) => s.go);
  const renameId = useCollectionsUi((s) => s.renameId);
  const paneRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pillRef = useRef<HTMLParagraphElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  // A just-removed member whose "Remove" had focus: once it is gone, focus moves to its neighbour.
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ id: string; index: number } | null>(null);
  const [focusPill, setFocusPill] = useState(false);

  // "+ New": the new collection's name is ready to be typed over.
  useEffect(() => {
    if (renameId !== collection.id) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    useCollectionsUi.getState().renameStarted();
  }, [renameId, collection.id]);

  useEffect(() => {
    if (!focusAfterRemove || members.some((s) => s.id === focusAfterRemove.id)) return;
    setFocusAfterRemove(null);
    const grid = gridRef.current;
    if (!grid) return;
    const removes = grid.querySelectorAll<HTMLButtonElement>('[data-member-remove]');
    const next =
      removes[Math.min(focusAfterRemove.index, removes.length - 1)] ??
      grid.querySelector<HTMLButtonElement>('[data-add-skins]');
    next?.focus();
  }, [focusAfterRemove, members]);

  // The Activate button turns into the pill: keep focus there instead of on <body>.
  useEffect(() => {
    if (!focusPill || !active) return;
    setFocusPill(false);
    pillRef.current?.focus();
  }, [focusPill, active]);

  const focusInside = () => paneRef.current?.contains(document.activeElement) ?? false;
  const totalBytes = members.reduce((sum, s) => sum + s.sizeBytes, 0);

  // Buttons stay enabled while busy (disabling a focused button drops focus to <body>); repeats are ignored.
  const onActivate = async () => {
    if (actions.activating) return;
    const hadFocus = focusInside();
    const ok = await actions.activate(collection);
    if (ok && hadFocus) setFocusPill(true);
  };

  const onDelete = async () => {
    if (actions.deleting) return;
    const hadFocus = focusInside();
    const ok = await actions.deleteCollection(collection);
    if (ok && hadFocus) onDeleted();
  };

  const onRemove = (skin: HangarSkin, index: number) => {
    if (gridRef.current?.contains(document.activeElement)) setFocusAfterRemove({ id: skin.id, index });
    void actions.removeMember(collection, skin);
  };

  return (
    <section
      ref={paneRef}
      aria-label={collection.name}
      className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto px-6 py-4.5"
    >
      <header className="flex items-start justify-between gap-5 border-b border-line-2 pb-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <InlineInput
            ref={nameRef}
            label={t('collections.nameLabel')}
            value={collection.name}
            required
            onCommit={(name) => void actions.rename(collection.id, name)}
            className="text-title leading-[normal] text-ink-1"
          />
          <InlineTextArea
            label={t('collections.descriptionLabel')}
            value={collection.description ?? ''}
            placeholder={t('collections.addDescription')}
            onCommit={(description) => void actions.describe(collection.id, description)}
            className="text-meta leading-[normal] text-ink-3"
          />
          <span className="font-mono text-mono-sm leading-[normal] text-ink-4">
            {t('collections.meta', { count: members.length, size: formatBytes(totalBytes) })}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button variant="ghost" size={32} onClick={() => void onDelete()}>
            {t('collections.delete')}
          </Button>
          {active ? (
            <p
              ref={pillRef}
              tabIndex={-1}
              className="flex h-8 items-center gap-2 rounded-ctl border border-amber-35 bg-amber-10 px-3 text-meta font-medium text-amber"
            >
              {t('collections.activeInGame')}
              <Check size={14} strokeWidth={1.75} aria-hidden />
            </p>
          ) : (
            <Button variant="primary" size={32} onClick={() => void onActivate()}>
              {t('collections.activate')}
            </Button>
          )}
        </div>
      </header>
      <ul
        ref={gridRef}
        aria-label={t('collections.members', { name: collection.name })}
        className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3"
      >
        {members.map((skin, i) => (
          <MemberCard key={skin.id} skin={skin} onRemove={() => onRemove(skin, i)} />
        ))}
        <li className="flex">
          <button
            type="button"
            data-add-skins
            onClick={() => go('hangar')}
            className="flex min-h-[120px] w-full flex-col items-center justify-center rounded-card border border-dashed border-line-3 p-3 text-center text-meta leading-[1.5] text-ink-4 hover:border-line-4 hover:text-ink-3 motion-safe:transition-colors motion-safe:duration-120"
          >
            {/* One line per span; the space keeps the accessible name readable ("…Hangar (select…"). */}
            {t('collections.addFromHangar')
              .split('\n')
              .map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && ' '}
                  <span>{line}</span>
                </Fragment>
              ))}
          </button>
        </li>
      </ul>
    </section>
  );
}

/** Right pane while the library loads. */
export function CollectionDetailSkeleton() {
  return (
    <div aria-hidden className="flex min-w-0 flex-col gap-3.5 overflow-hidden px-6 py-4.5">
      <div className="flex flex-col gap-2 border-b border-line-2 pb-3.5">
        <Skeleton className="h-6 w-1/3 rounded-tag" />
        <Skeleton className="h-3 w-1/2 rounded-tag" />
        <Skeleton className="h-3 w-1/5 rounded-tag" />
      </div>
      <div className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="overflow-hidden rounded-card border border-line-2 bg-bg-3">
            <Skeleton className="aspect-video" />
            <div className="flex flex-col gap-2 px-3 py-2.5">
              <div className="h-3 w-[70%] rounded-tag bg-bg-skel" />
              <div className="h-2.5 w-1/2 rounded-tag bg-bg-4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
