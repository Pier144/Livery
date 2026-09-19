import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Fragment, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { call } from '@/lib/tauri';
import { isOfflineError } from '@/queries/wtlive';
import { useUi } from '@/store/ui';
import type { AppError, HangarSkin, TextureInfo, WtLiveSkin } from '@/types';
import {
  formatTextureSize,
  needsAttention,
  orderTextures,
  resolutionText,
  texturesTotal,
  textureWarning,
} from './detailModel';

/**
 * `read_textures` of the installed copy when there is one, else of the post's archive (WT Live).
 * When an install lands, the archive's rows stay up until the installed copy's arrive.
 */
function useSkinTextures(skin: WtLiveSkin, hangarSkin: HangarSkin | undefined) {
  const args = hangarSkin ? { skinId: hangarSkin.id } : { wtliveId: skin.id };
  return useQuery<TextureInfo[], AppError>({
    queryKey: ['textures', args],
    queryFn: () => call<TextureInfo[]>('read_textures', args),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/**
 * Textures tab: "Textures in the archive" + mono "{n} files · {size}", an amber banner when files
 * need attention, and the spec table (warnings as amber lines under their row, localized by kind;
 * missing files read "—" and "missing"; the blk last). Offline → the offline state, in the tab.
 */
export function TexturesTab({ skin, hangarSkin }: { skin: WtLiveSkin; hangarSkin: HangarSkin | undefined }) {
  const { t } = useTranslation();
  const query = useSkinTextures(skin, hangarSkin);
  const go = useUi((s) => s.go);
  const headingId = useId();

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3.5 px-6 py-5">
        <span className="sr-only">{t('detail.textures.loading')}</span>
        <Skeleton className="h-5 w-[220px] rounded-tag" />
        <div aria-hidden className="flex flex-col gap-px overflow-hidden rounded-card border border-line-2 bg-bg-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError) {
    const offline = isOfflineError(query.error);
    return (
      <EmptyState
        className="px-6 py-10"
        dot={offline}
        title={offline ? t('detail.offline.title') : t('detail.textures.loadFailedTitle')}
        body={offline ? t('detail.offline.body') : errorText(query.error, t)}
        primary={offline ? { label: t('detail.offline.hangar'), onClick: () => go('hangar') } : undefined}
        secondary={{ label: t('common.retry'), onClick: () => void query.refetch() }}
      />
    );
  }

  const rows = orderTextures(query.data);
  const attention = rows.filter(needsAttention).length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3.5 px-6 py-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={headingId} className="text-[15px] font-medium leading-[1.3]">
          {t('detail.textures.title')}
        </h2>
        <span className="font-mono text-mono-sm text-ink-4">
          {t('detail.textures.meta', { count: rows.length, size: formatTextureSize(texturesTotal(rows)) })}
        </span>
      </div>
      {attention > 0 && (
        <p className="flex items-center gap-2.5 rounded-ctl border border-amber-35 bg-amber-10 px-3 py-2.5 text-meta text-ink-1">
          <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-amber" />
          {t('detail.textures.attention', { count: attention })}
        </p>
      )}
      {rows.length === 0 ? <p className="text-body text-ink-3">{t('detail.textures.empty')}</p> : <TextureTable rows={rows} />}
    </section>
  );
}

const HEAD = 'py-2 text-left font-normal';

function TextureTable({ rows }: { rows: TextureInfo[] }) {
  const { t } = useTranslation();
  const baseId = useId();
  return (
    <div className="overflow-hidden rounded-card border border-line-2 bg-bg-3">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[20%]" />
          <col className="w-[20%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-line-2 font-mono text-mono-label uppercase text-ink-4">
            <th scope="col" className={cn(HEAD, 'pl-3.5 pr-3')}>
              {t('detail.textures.col.file')}
            </th>
            <th scope="col" className={cn(HEAD, 'pr-3')}>
              {t('detail.textures.col.resolution')}
            </th>
            <th scope="col" className={cn(HEAD, 'pr-3')}>
              {t('detail.textures.col.format')}
            </th>
            <th scope="col" className={cn(HEAD, 'pr-3.5 text-right')}>
              {t('detail.textures.col.size')}
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-mono-data text-ink-2 [&>tr:last-child]:border-b-0">
          {rows.map((row, i) => {
            const warning = textureWarning(t, row);
            const warnId = `${baseId}-w${i}`;
            const tone = warning ? 'text-amber' : undefined;
            return (
              <Fragment key={`${row.file}-${i}`}>
                <tr className={warning ? undefined : 'border-b border-line-grid'}>
                  <td className="py-2.5 pl-3.5 pr-3" aria-describedby={warning ? warnId : undefined}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="h-7 w-7 flex-none rounded-tag border border-line-3 bg-placeholder-thumb" />
                      <span data-selectable className={cn('truncate', tone)} title={row.file}>
                        {row.file}
                      </span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">{resolutionText(row)}</td>
                  <td className="py-2.5 pr-3">{row.missing ? '—' : (row.format ?? '—')}</td>
                  <td className={cn('py-2.5 pr-3.5 text-right', tone)}>
                    {row.missing
                      ? t('detail.textures.missing')
                      : row.sizeBytes === undefined
                        ? '—'
                        : formatTextureSize(row.sizeBytes)}
                  </td>
                </tr>
                {warning && (
                  <tr className="border-b border-line-grid">
                    <td id={warnId} colSpan={4} className="pb-2.5 pl-[52px] pr-3.5 font-sans text-meta text-amber">
                      {warning}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
