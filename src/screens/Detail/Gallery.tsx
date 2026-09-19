import { Columns2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { useWtLiveSearch } from '@/queries/wtlive';
import { useDetail } from '@/store/detail';
import type { WtLiveSkin } from '@/types';
import { Compare } from './Compare';
import { galleryViews, rovingIndex, sameVehicleSkins, type GalleryView } from './detailModel';
import { useFocusFallback } from './useFocusFallback';

/** "Zoom in" / "Compare" over the image (prototype: rgba(15,16,18,.9) fill). */
const OVERLAY_BUTTON =
  'inline-flex h-ctl items-center gap-1.5 whitespace-nowrap rounded-ctl border border-line-3 bg-bg-0/90 px-2.5 text-meta font-medium leading-none text-ink-1 hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120';

/**
 * Gallery tab: main image (corner marks, "1 / 4" counter, Zoom in/out toggling scale(1.6) over
 * 250ms, Compare when other skins of the vehicle are known) and 120×68 thumbnails (a radio group:
 * ← → Home End move the selection). Compare mode replaces both with two panes, and ends by itself
 * when no other skin of the vehicle is left to compare with.
 */
export function Gallery({ skin }: { skin: WtLiveSkin }) {
  const { t } = useTranslation();
  const views = useMemo(() => galleryViews(skin.images), [skin.images]);
  const index = useDetail((s) => Math.min(s.galleryIndex, views.length - 1));
  const zoom = useDetail((s) => s.zoom);
  const compare = useDetail((s) => s.compare);
  const compareWith = useDetail((s) => s.compareWith);
  const { setGalleryIndex, toggleZoom, openCompare, exitCompare, setCompareWith } = useDetail.getState();

  // Other skins of the same vehicle: most downloaded first (cached by TanStack Query).
  const search = useWtLiveSearch({ vehicle: skin.vehicle.code, sort: 'downloads', page: 0 });
  const candidates = useMemo(() => sameVehicleSkins(skin, [search.data?.items]), [skin, search.data]);
  const compareSkin = candidates.find((c) => c.id === compareWith) ?? candidates[0];
  const inCompare = compare && compareSkin !== undefined;

  // The other skins can go away (a refetch without them): leave compare mode rather than keep an
  // invisible layer that the next Escape would be spent on. Not while the search is still loading.
  const answered = !search.isPending;
  useEffect(() => {
    if (compare && answered && compareSkin === undefined) exitCompare();
  }, [compare, answered, compareSkin, exitCompare]);

  const zoomButtonRef = useRef<HTMLButtonElement>(null);
  const compareButtonRef = useRef<HTMLButtonElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The button that was pressed disappears with its view: keep the keyboard user in place (on
  // Zoom when Compare went away too).
  useFocusFallback(inCompare, inCompare ? activeOptionRef : compareSkin ? compareButtonRef : zoomButtonRef);

  const view = views[index] ?? views[0]!;
  const viewLabel = (v: GalleryView) => (v.view ? t(`detail.gallery.view.${v.view}`) : t('detail.gallery.image', { n: v.n }));

  const onThumbKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingIndex(e.key, index, views.length);
    if (next === null) return;
    e.preventDefault();
    setGalleryIndex(next);
    thumbRefs.current[next]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-5">
      {inCompare ? (
        <Compare
          a={skin}
          b={compareSkin}
          candidates={candidates}
          onPick={setCompareWith}
          onExit={exitCompare}
          activeRef={activeOptionRef}
        />
      ) : (
        <>
          <div className="relative flex min-h-[200px] flex-1 items-center justify-center overflow-hidden rounded-card border border-line-2 bg-placeholder-stage">
            <div
              data-testid="gallery-stage"
              className={cn(
                'flex h-full w-full items-center justify-center motion-safe:transition-transform motion-safe:duration-250 motion-safe:ease-out',
                zoom ? 'scale-[1.6]' : 'scale-100',
              )}
            >
              {view.src ? (
                <img
                  src={view.src}
                  alt={t('detail.gallery.imageAlt', { name: skin.name, view: viewLabel(view) })}
                  draggable={false}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span
                  role="img"
                  aria-label={t('detail.gallery.imageAlt', { name: skin.name, view: viewLabel(view) })}
                  className="font-mono text-mono-data text-ink-4"
                >
                  {t('detail.gallery.placeholder', { vehicle: skin.vehicle.name, view: viewLabel(view) })}
                </span>
              )}
            </div>
            <span aria-hidden className="absolute left-2.5 top-2.5 h-[9px] w-[9px] border-l border-t border-line-mark" />
            <span aria-hidden className="absolute bottom-2.5 right-2.5 h-[9px] w-[9px] border-b border-r border-line-mark" />
            <span aria-hidden className="absolute right-3 top-2.5 font-mono text-[10px] leading-[normal] tracking-[0.06em] text-ink-3">
              {t('detail.gallery.counter', { n: view.n, total: views.length })}
            </span>
            <div className="absolute bottom-3 left-3 flex gap-1.5">
              <button ref={zoomButtonRef} type="button" onClick={toggleZoom} className={OVERLAY_BUTTON}>
                {zoom ? <ZoomOut size={14} strokeWidth={1.75} aria-hidden /> : <ZoomIn size={14} strokeWidth={1.75} aria-hidden />}
                {zoom ? t('detail.gallery.zoomOut') : t('detail.gallery.zoomIn')}
              </button>
              {compareSkin && (
                <button
                  ref={compareButtonRef}
                  type="button"
                  title={t('detail.gallery.compareHint')}
                  onClick={() => openCompare(compareSkin.id)}
                  className={OVERLAY_BUTTON}
                >
                  <Columns2 size={14} strokeWidth={1.75} aria-hidden />
                  {t('detail.gallery.compare')}
                </button>
              )}
            </div>
          </div>
          <div role="radiogroup" aria-label={t('detail.gallery.views')} className="flex flex-none gap-2" onKeyDown={onThumbKeyDown}>
            {views.map((v, i) => {
              const active = i === index;
              return (
                <button
                  key={v.key}
                  ref={(el) => {
                    thumbRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={viewLabel(v)}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setGalleryIndex(i)}
                  className={cn(
                    'h-[68px] w-[120px] flex-none overflow-hidden rounded-ctl border bg-placeholder font-mono text-[10px] leading-[normal] text-ink-3 motion-safe:transition-colors motion-safe:duration-120',
                    active ? 'border-amber' : 'border-line-2 hover:border-line-mark',
                  )}
                >
                  {v.src ? <img src={v.src} alt="" draggable={false} className="h-full w-full object-cover" /> : viewLabel(v)}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
