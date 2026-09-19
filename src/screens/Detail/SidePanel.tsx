import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ExternalLink } from 'lucide-react';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { call, toAppError } from '@/lib/tauri';
import { useCollections, useSetCollectionSkins } from '@/queries/collections';
import { FOLLOWING_KEY, isOfflineError, useFollowing, useSetFollow } from '@/queries/wtlive';
import type { WtInstall, WtInstallState } from '@/store/installs';
import { toast } from '@/store/toasts';
import type { AppError, ConflictPolicy, FollowEntry, FollowKind, HangarSkin, WtLiveSkin } from '@/types';
import { formatCount, formatPosted, initialOf, stepParts } from './detailModel';
import { useFocusFallback } from './useFocusFallback';

interface SidePanelProps {
  skin: WtLiveSkin;
  /** The installed copy (temporary included), if any. */
  hangarSkin: HangarSkin | undefined;
  install: { state: WtInstallState; start: (conflict?: ConflictPolicy) => void };
  track: WtInstall | undefined;
  /** Vehicle card: Explore filtered by this vehicle. */
  onOpenVehicle: () => void;
  /** "Keep or discard" on a skin being tried: opens the Try in game tab. */
  onOpenTry: () => void;
}

// `leading-[normal]` throughout: the prototype sets every text with the `font:` shorthand.
const LABEL = 'font-mono text-mono-label uppercase leading-[normal] text-ink-4';

/**
 * Side panel (320px, bg-1): author with Follow and the original post (creators always visible),
 * vehicle card (+ vehicle Follow), stats, files, then Install / progress / Installed and "Add to
 * collection".
 */
export function SidePanel({ skin, hangarSkin, install, track, onOpenVehicle, onOpenTry }: SidePanelProps) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('detail.side.label')}
      className="flex min-h-0 flex-col gap-4.5 overflow-y-auto border-l border-line-2 bg-bg-1 p-5"
    >
      <AuthorBlock skin={skin} />
      <VehicleBlock skin={skin} onOpen={onOpenVehicle} />
      <Stats skin={skin} />
      <Files skin={skin} />
      <div className="flex-1" />
      <div className="flex flex-col gap-2">
        <InstallAction skin={skin} install={install} track={track} onOpenTry={onOpenTry} />
        <CollectionAction hangarSkin={hangarSkin && !hangarSkin.temporary ? hangarSkin : undefined} />
      </div>
    </section>
  );
}

// ── Author / vehicle ────────────────────────────────────────────────────────

function AuthorBlock({ skin }: { skin: WtLiveSkin }) {
  const { t } = useTranslation();
  const { author } = skin;
  const headingId = useId();

  // No browser opener yet (tauri-plugin-opener isn't approved): the link goes to the clipboard.
  const copyPostLink = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(skin.postUrl);
      toast(t('detail.linkCopied'));
    } catch {
      toast(t('detail.linkCopyFailed', { url: skin.postUrl }));
    }
  };

  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className={LABEL}>
        {t('detail.author.label')}
      </h2>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border border-line-3 bg-bg-5 text-meta font-medium text-ink-2"
        >
          {initialOf(author.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-card leading-[normal] text-ink-1" title={author.name}>
            {author.name}
          </span>
          <span className="text-[11px] leading-[normal] text-ink-4">{t('detail.author.onWtLive')}</span>
        </div>
        <FollowButton kind="author" id={author.id} name={author.name} />
      </div>
      <button
        type="button"
        title={t('detail.author.openPostHint')}
        onClick={() => void copyPostLink()}
        className="inline-flex items-center gap-1.5 self-start text-meta leading-[normal] text-amber underline underline-offset-[3px] hover:text-amber-hover motion-safe:transition-colors motion-safe:duration-120"
      >
        {t('detail.author.openPost')}
        <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

function VehicleBlock({ skin, onOpen }: { skin: WtLiveSkin; onOpen: () => void }) {
  const { t } = useTranslation();
  const { vehicle } = skin;
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className={LABEL}>
          {t('detail.vehicle.label')}
        </h2>
        {/* A sibling of the card button, never inside it (no nested interactive controls). */}
        <FollowButton kind="vehicle" id={vehicle.code} name={vehicle.name} small />
      </div>
      <button
        type="button"
        title={t('detail.vehicle.open')}
        onClick={onOpen}
        className="flex flex-col gap-[3px] rounded-ctl border border-line-2 bg-bg-3 px-3 py-2.5 text-left hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120"
      >
        <span className="text-body font-medium leading-[normal] text-ink-1">{vehicle.name}</span>
        <span className="font-mono text-[10px] leading-[normal] text-ink-4 [overflow-wrap:anywhere]">
          {t('detail.vehicle.meta', {
            code: vehicle.code,
            nation: t(`hangar.nation.${vehicle.nation}`),
            class: vehicle.class,
          })}
        </span>
      </button>
    </div>
  );
}

/**
 * Follow / Following for an author or a vehicle. Unfollowing is undoable: Undo follows again from
 * the entry's old "last seen", so its "N new" in Following comes back exactly.
 */
function FollowButton({ kind, id, name, small = false }: { kind: FollowKind; id: string; name: string; small?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useFollowing();
  const setFollow = useSetFollow();
  const entry = data?.find((e) => e.kind === kind && e.id === id);
  const following = entry !== undefined;

  const toggle = () => {
    if (setFollow.isPending) return;
    const follow = !following;
    const lastSeenAt = entry?.lastSeenAt;
    setFollow.mutateAsync({ kind, id, name, follow }).then(
      () => {
        if (follow) {
          toast(t('detail.follow.followed', { name }));
          return;
        }
        // Undo outlives this screen: it talks to the backend directly, not through the hook.
        toast.undoable(t('detail.follow.unfollowed', { name }), async () => {
          try {
            const args = lastSeenAt ? { kind, id, name, follow: true, lastSeenAt } : { kind, id, name, follow: true };
            qc.setQueryData(FOLLOWING_KEY, await call<FollowEntry[]>('following_set', args));
          } catch (e) {
            toast(t('detail.follow.failed', { message: errorText(toAppError(e), t) }));
          }
        });
      },
      (e: AppError) => toast(t('detail.follow.failed', { message: errorText(e, t) })),
    );
  };

  return (
    <button
      type="button"
      // The name carries the state ("Follow X" / "Following X") and keeps the visible text (WCAG
      // 2.5.3); no aria-pressed, since a toggle's name must not change with its state (APG).
      aria-label={following ? t('detail.follow.followingName', { name }) : t('detail.follow.followName', { name })}
      aria-disabled={setFollow.isPending || undefined}
      onClick={toggle}
      className={cn(
        'flex-none whitespace-nowrap rounded-ctl border border-line-3 bg-bg-4 font-medium leading-none hover:border-line-4 aria-disabled:cursor-default motion-safe:transition-colors motion-safe:duration-120',
        small ? 'h-6 px-2 text-[11px]' : 'h-[26px] px-2.5 text-meta',
        following ? 'text-amber' : 'text-ink-1',
      )}
    >
      {following ? t('detail.follow.following') : t('detail.follow.follow')}
    </button>
  );
}

// ── Stats / files ───────────────────────────────────────────────────────────

function Stats({ skin }: { skin: WtLiveSkin }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const cells = [
    { key: 'downloads', value: formatCount(skin.downloads, language), big: true },
    { key: 'likes', value: formatCount(skin.likes, language), big: true },
    { key: 'category', value: t(`detail.category.${skin.category}`, { defaultValue: skin.category }), big: false },
    { key: 'posted', value: formatPosted(skin.postedAt, language), big: false },
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-ctl border border-line-2 bg-line-2">
      {cells.map((cell) => (
        <div key={cell.key} className="flex min-w-0 flex-col gap-0.5 bg-bg-3 px-3 py-2.5">
          <dt className={LABEL}>{t(`detail.stats.${cell.key}`)}</dt>
          <dd className={cn('m-0 truncate text-ink-1', cell.big ? 'text-[15px] font-medium leading-[normal]' : 'text-body leading-[normal]')}>
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Files({ skin }: { skin: WtLiveSkin }) {
  const { t } = useTranslation();
  const headingId = useId();
  const files = skin.files ?? [];
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex justify-between gap-2 font-mono text-mono-label leading-[normal] text-ink-4">
        <h2 id={headingId} className="uppercase">
          {t('detail.files.label')}
        </h2>
        <span>{t('detail.files.meta', { count: files.length, size: formatBytes(skin.sizeBytes) })}</span>
      </div>
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1 font-mono text-mono-sm leading-[normal] text-ink-3">
          {files.map((f) => (
            <li key={f.path} data-selectable className="truncate" title={f.path}>
              {f.path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-4">{t('detail.files.none')}</p>
      )}
    </div>
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

interface InstallActionProps {
  skin: WtLiveSkin;
  install: SidePanelProps['install'];
  track: WtInstall | undefined;
  onOpenTry: () => void;
}

/** Install (36px) → progress (Download ✓ · Extracting 56%) → Installed ✓ in Hangar, or a failure with Retry. */
function InstallAction({ skin, install, track, onOpenTry }: InstallActionProps) {
  const { t } = useTranslation();
  const focusRef = useRef<HTMLElement | null>(null);
  const setFocusTarget = (el: HTMLElement | null) => {
    focusRef.current = el;
  };
  // A failed Try in game belongs to the Try tab; here the skin can still be installed normally.
  const state: WtInstallState = install.state.kind === 'error' && track?.mode === 'temporary' ? { kind: 'idle' } : install.state;
  useFocusFallback(state.kind, focusRef);

  switch (state.kind) {
    case 'idle':
      return (
        <Button ref={setFocusTarget} variant="primary" size={36} className="w-full" onClick={() => install.start()}>
          {t('detail.install.install')}{' '}
          <span className="font-mono text-mono-sm font-normal opacity-75">{formatBytes(skin.sizeBytes)}</span>
        </Button>
      );
    case 'installing': {
      const parts = stepParts(state.step);
      const now =
        parts.now === 'done' ? t('detail.install.step.done') : t('detail.install.stepNow', { step: t(`detail.install.running.${parts.now}`), pct: state.pct });
      return (
        <div
          ref={setFocusTarget}
          tabIndex={-1}
          role="progressbar"
          aria-label={t('detail.install.progressLabel', { name: skin.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.pct}
          aria-valuetext={now}
          className="flex h-btn-lg flex-col justify-center gap-1.5 focus:outline-none"
        >
          <div className="h-[3px] overflow-hidden rounded-[2px] bg-bg-5">
            <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-linear" style={{ width: `${state.pct}%` }} />
          </div>
          <div aria-hidden className="flex justify-between gap-2 font-mono text-[10px] leading-[normal]">
            <span className="flex items-center gap-2 text-ink-3">
              {parts.done.map((step) => (
                <span key={step} className="flex items-center gap-1">
                  {t(`detail.install.step.${step}`)}
                  <Check size={10} strokeWidth={1.75} />
                </span>
              ))}
            </span>
            <span className="text-amber">{now}</span>
          </div>
        </div>
      );
    }
    case 'installed':
      return (
        <div
          ref={setFocusTarget}
          tabIndex={-1}
          className="flex h-btn-lg items-center justify-between gap-2 rounded-ctl border border-amber-35 bg-amber-10 px-3 text-body font-medium text-amber focus:outline-none"
        >
          {state.temporary ? (
            <>
              <span>{t('detail.install.trying')}</span>
              <button
                type="button"
                onClick={onOpenTry}
                className="text-[11px] font-normal text-ink-2 underline underline-offset-[3px] hover:text-ink-1"
              >
                {t('detail.install.tryingAction')}
              </button>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                {t('detail.install.installed')}
                <Check size={14} strokeWidth={1.75} aria-hidden />
              </span>
              <span className="font-mono text-[10px] font-normal text-ink-3">{t('detail.install.inHangar')}</span>
            </>
          )}
        </div>
      );
    case 'error': {
      const offline = isOfflineError({ code: state.code ?? 'internal', message: state.message });
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-btn-lg items-center justify-between gap-2 rounded-ctl border border-danger-40 bg-danger-8 px-3">
            <span className="text-body font-medium text-danger">{t('detail.install.failed')}</span>
            <span className="flex items-center gap-3">
              {state.code === 'conflict' && (
                <button
                  type="button"
                  onClick={() => install.start('copy')}
                  className="text-[11px] text-ink-2 underline underline-offset-[3px] hover:text-ink-1"
                >
                  {t('detail.install.asCopy')}
                </button>
              )}
              <button
                ref={setFocusTarget}
                type="button"
                onClick={() => install.start()}
                className="text-[11px] text-ink-1 underline underline-offset-[3px] hover:text-amber"
              >
                {t('common.retry')}
              </button>
            </span>
          </div>
          <p role="alert" className="text-[11px] leading-[1.4] text-ink-3">
            {offline ? t('detail.install.offline') : errorText({ code: state.code, message: state.message }, t)}
          </p>
        </div>
      );
    }
  }
}

/** "Add to collection ▾": a menu of collections once the skin is in My Hangar; before that, disabled. */
function CollectionAction({ hangarSkin }: { hangarSkin: HangarSkin | undefined }) {
  const { t } = useTranslation();
  const { data } = useCollections();
  const setSkins = useSetCollectionSkins();
  const collections = data?.collections ?? [];
  const trigger =
    'flex h-8 w-full items-center justify-center gap-1.5 rounded-ctl border border-line-3 bg-bg-4 text-meta font-medium leading-none text-ink-1 hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120';

  if (!hangarSkin) {
    return (
      <button
        type="button"
        aria-disabled="true"
        title={t('detail.collections.installFirst')}
        className={cn(trigger, 'cursor-default opacity-50 hover:border-line-3')}
      >
        {t('detail.collections.add')}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
      </button>
    );
  }

  const items: MenuItem[] =
    collections.length > 0
      ? collections.map((c) => ({
          value: c.id,
          label: c.name,
          textValue: c.name,
          hint: c.skinIds.includes(hangarSkin.id) ? (
            <>
              <Check size={14} strokeWidth={1.75} aria-hidden className="text-amber" />
              <span className="sr-only">{t('detail.collections.member')}</span>
            </>
          ) : undefined,
        }))
      : [{ value: '', label: t('detail.collections.none'), disabled: true }];

  const pick = (id: string) => {
    const collection = collections.find((c) => c.id === id);
    if (!collection) return;
    if (collection.skinIds.includes(hangarSkin.id)) {
      toast(t('detail.collections.already', { name: collection.name }));
      return;
    }
    setSkins.mutateAsync({ id, add: [hangarSkin.id] }).then(
      () => toast(t('detail.collections.added', { name: collection.name })),
      (e: AppError) => toast(t('detail.collections.failed', { message: errorText(e, t) })),
    );
  };

  return (
    <Menu
      items={items}
      onSelect={pick}
      placement="top"
      className="flex w-full"
      menuWidthClass="w-full"
      renderTrigger={(props) => (
        <button {...props} className={trigger}>
          {t('detail.collections.add')}
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    />
  );
}
