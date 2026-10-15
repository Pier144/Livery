import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { openLink } from '@/lib/opener';
import { useExplore } from '@/store/explore';
import { useUi } from '@/store/ui';
import type { PostRun, WtLiveSkin } from '@/types';
import { galleryImages } from './detailModel';

const LABEL = 'font-mono text-mono-label uppercase leading-[normal] text-ink-4';

interface PostTabProps {
  skin: WtLiveSkin;
  /** A picture was picked: the Gallery opens on it (index into `galleryImages(skin)`). */
  onOpenImage: (index: number) => void;
}

/**
 * Post tab: what the author wrote on WT Live (paragraphs, bold/italic, links that stay on WT Live —
 * its `/away/` page warns before another site), the hashtags (each searches Explore) and the
 * pictures embedded in the text (each opens in the Gallery). The text comes from
 * `wtlive::text` as plain runs: no HTML from WT Live is ever rendered.
 */
export function PostTab({ skin, onOpenImage }: PostTabProps) {
  const { t } = useTranslation();
  const textId = useId();
  const tagsId = useId();
  const picturesId = useId();
  const description = skin.description;

  if (!description || (description.paragraphs.length === 0 && description.tags.length === 0 && description.images.length === 0)) {
    return <EmptyState title={t('detail.post.emptyTitle')} body={t('detail.post.emptyBody')} className="h-full" />;
  }

  const gallery = galleryImages(skin);
  const searchTag = (tag: string) => {
    useExplore.getState().applyTag(tag);
    useUi.getState().go('explore');
  };

  return (
    <div className="flex flex-col gap-6 px-6 py-5">
      <section aria-labelledby={textId} className="flex flex-col gap-2.5">
        <h2 id={textId} className={LABEL}>
          {t('detail.post.fromAuthor', { name: skin.author.name })}
        </h2>
        {description.paragraphs.length > 0 ? (
          <div data-selectable className="flex max-w-[680px] flex-col gap-3 text-body leading-[1.6] text-ink-2">
            {description.paragraphs.map((runs, i) => (
              <p key={i} className="break-words">
                {runs.map((run, j) => (
                  <Run key={j} run={run} />
                ))}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-body text-ink-3">{t('detail.post.noText')}</p>
        )}
      </section>

      {description.tags.length > 0 && (
        <section aria-labelledby={tagsId} className="flex flex-col gap-2.5">
          <h2 id={tagsId} className={LABEL}>
            {t('detail.post.tags')}
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {description.tags.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  title={t('detail.post.tagHint', { tag })}
                  onClick={() => searchTag(tag)}
                  className="inline-flex h-[26px] items-center rounded-pill border border-line-3 bg-bg-4 px-2.5 font-mono text-mono-sm leading-none text-ink-2 hover:border-line-mark hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
                >
                  #{tag}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {description.images.length > 0 && (
        <section aria-labelledby={picturesId} className="flex flex-col gap-2.5">
          <h2 id={picturesId} className={LABEL}>
            {t('detail.post.pictures', { count: description.images.length })}
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {description.images.map((src, i) => (
              <li key={src}>
                <button
                  type="button"
                  aria-label={t('detail.post.openPicture', { n: i + 1 })}
                  onClick={() => onOpenImage(Math.max(0, gallery.indexOf(src)))}
                  className="block aspect-video w-full overflow-hidden rounded-card border border-line-2 bg-placeholder hover:border-line-mark motion-safe:transition-colors motion-safe:duration-120"
                >
                  <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ink-4 at 11px: the attribution, like the conflict dialog's footer. */}
      <p className="text-[11px] leading-[normal] text-ink-4">{t('detail.post.source')}</p>
    </div>
  );
}

function Run({ run }: { run: PostRun }): ReactNode {
  const { t } = useTranslation();
  switch (run.kind) {
    case 'break':
      return <br />;
    case 'link':
      return (
        <button
          type="button"
          title={t('detail.post.linkHint')}
          onClick={() => void openLink(run.url, t, 'wtlive')}
          className="inline break-all text-left text-amber underline underline-offset-[3px] hover:text-amber-hover motion-safe:transition-colors motion-safe:duration-120"
        >
          {run.text}
        </button>
      );
    case 'text':
      return <span className={cn(run.bold && 'font-semibold text-ink-1', run.italic && 'italic')}>{run.text}</span>;
  }
}
