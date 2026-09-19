import { memo, type KeyboardEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { WtLiveSkin } from '@/types';
import { CardAction } from './CardAction';
import { compactNumber } from './exploreModel';

export interface SkinCardProps {
  skin: WtLiveSkin;
  /** Opens the Skin detail; must be stable (cards are memoized). */
  onOpen: (id: string) => void;
}

/** 16:9 screenshot (or the striped placeholder) with the category tag, NEW badge and corner marks. */
export function SkinImage({ skin, showCategory = true }: { skin: WtLiveSkin; showCategory?: boolean }) {
  const { t } = useTranslation();
  const src = skin.images[0];
  return (
    // Passive: clicks go through to the card's hit area underneath. A span, so it may sit in a <button>.
    <span aria-hidden className="pointer-events-none relative block aspect-video overflow-hidden rounded-t-[7px] bg-placeholder">
      {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
      {showCategory && (
        <span className="absolute left-2 top-2 rounded-menu bg-bg-tag px-1.5 py-0.5 font-mono text-[10px] leading-[normal] tracking-[.04em] text-ink-2">
          {t(`explore.category.${skin.category}`)}
        </span>
      )}
      {skin.isNew && (
        <span className="absolute right-2 top-2 rounded-menu bg-amber px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-[normal] tracking-[.04em] text-onAmber">
          {t('explore.card.new')}
        </span>
      )}
      <span className="absolute bottom-1.5 left-1.5 h-[9px] w-[9px] border-b border-l border-line-mark" />
      <span className="absolute bottom-1.5 right-1.5 h-[9px] w-[9px] border-b border-r border-line-mark" />
    </span>
  );
}

/**
 * Explore grid card (README §2). Opening the detail is a full-card `role=button` hit area drawn
 * *under* the Install / Retry buttons rather than the card's own role, so those buttons are not
 * nested inside a button (axe `nested-interactive`) — the My Hangar card pattern. The card is a
 * named group so its repeated "Install 48 MB" buttons have context.
 */
export const SkinCard = memo(function SkinCard({ skin, onOpen }: SkinCardProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Space would scroll the grid; a held Enter would open it again and again.
    e.preventDefault();
    if (!e.repeat) onOpen(skin.id);
  };

  return (
    <div
      data-skin-id={skin.id}
      role="group"
      aria-label={skin.name}
      className="relative flex min-w-0 flex-col rounded-card border border-line-2 bg-bg-3 hover:border-amber hover:shadow-card motion-safe:transition-[border-color,box-shadow] motion-safe:duration-120"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={skin.name}
        title={skin.name}
        onClick={() => onOpen(skin.id)}
        onKeyDown={onKeyDown}
        // Covers the border too, so the focus ring sits 2px outside the card's edge.
        className="absolute -inset-px cursor-pointer rounded-card"
      />
      <SkinImage skin={skin} />
      <div className="flex min-w-0 flex-col gap-[7px] p-3">
        {/* A heading, so screen-reader users can move from result to result. */}
        <h2 className="truncate text-card text-ink-1">{skin.name}</h2>
        <div className="flex min-w-0 items-center gap-1.5 text-meta leading-[normal] text-ink-3">
          <span className="flex-none rounded-tag border border-line-3 px-1 py-px font-mono text-[10px] leading-[normal] text-ink-2">
            {skin.vehicle.nation}
          </span>
          <span className="truncate">{skin.vehicle.name}</span>
        </div>
        <div className="flex items-center justify-between gap-2 leading-[normal]">
          <span className="min-w-0 truncate text-meta leading-[normal] text-ink-3">
            <Trans i18nKey="explore.card.by" values={{ author: skin.author.name }} components={{ author: <span className="text-ink-2" /> }} />
          </span>
          <span aria-hidden className="flex-none whitespace-nowrap font-mono text-mono-sm leading-[normal] text-ink-4">
            {t('explore.card.stats', { downloads: compactNumber(skin.downloads, lang), likes: compactNumber(skin.likes, lang) })}
          </span>
          <span className="sr-only">{t('explore.card.statsFull', { downloads: skin.downloads, likes: skin.likes })}</span>
        </div>
        <CardAction skin={skin} />
      </div>
    </div>
  );
});
