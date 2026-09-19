import { Minus, Square, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@/components/ui/Kbd';
import { cn } from '@/lib/cn';
import { appWindow } from '@/lib/tauri';
import { useUi } from '@/store/ui';

/**
 * Tauri 2 only starts a window drag when the pressed element itself carries the attribute,
 * so it goes on the header and on every non-interactive child — never on buttons.
 */
const drag = { 'data-tauri-drag-region': true } as const;

/** Tracks the native maximized state (drives the maximize/restore label). */
function useIsMaximized() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let latest = 0;
    let unlisten: (() => void) | undefined;
    // Resize fires in bursts; only the newest query may win, so a slow stale answer cannot flip the label back.
    const sync = () => {
      const seq = ++latest;
      appWindow
        .isMaximized()
        .then((value) => {
          if (alive && seq === latest) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    appWindow
      .onResized(sync)
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return maximized;
}

interface WindowButtonProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  danger?: boolean;
}

function WindowButton({ label, icon: Icon, onClick, danger }: WindowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-[26px] w-[34px] items-center justify-center rounded-menu text-ink-4 motion-safe:transition-colors motion-safe:duration-120',
        danger ? 'hover:bg-danger-close hover:text-white' : 'hover:bg-bg-hover hover:text-ink-1',
      )}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export function TitleBar() {
  const { t } = useTranslation();
  const online = useUi((s) => s.online);
  const maximized = useIsMaximized();
  const paletteOpen = useUi((s) => s.palette.open);

  // box-content: 38px of content plus the 1px border, like the prototype, so the 26px controls sit on whole pixels.
  return (
    <header
      {...drag}
      className="box-content grid h-titlebar flex-none grid-cols-[1fr_auto_1fr] items-center border-b border-line-2 bg-bg-0 px-3"
    >
      <div {...drag} className="flex min-w-0 items-center gap-2.5">
        <span {...drag} aria-hidden className="h-2 w-2 flex-none rounded-full bg-amber shadow-glow" />
        <span {...drag} className="text-brand leading-none text-ink-1">
          {t('common.brand')}
        </span>
        <span {...drag} role="status" className="flex">
          {!online && (
            <span
              {...drag}
              className="ml-1.5 rounded-tag border border-line-3 px-1.5 py-px font-mono text-[10px] leading-[normal] text-ink-3"
            >
              {t('common.titlebar.offline')}
            </span>
          )}
        </span>
      </div>

      <button
        type="button"
        onClick={() => useUi.getState().openPalette()}
        aria-haspopup="dialog"
        aria-expanded={paletteOpen}
        aria-keyshortcuts="Control+K"
        className="flex h-[26px] w-[420px] items-center gap-2.5 rounded-ctl border border-line-2 bg-bg-input px-2.5 text-left text-meta text-ink-4 hover:border-line-4 hover:text-ink-3 motion-safe:transition-colors motion-safe:duration-120"
      >
        <span className="flex-1 truncate">{t('common.titlebar.search')}</span>
        <Kbd>{t('common.titlebar.searchShortcut')}</Kbd>
      </button>

      <div {...drag} className="flex justify-end gap-1">
        <WindowButton label={t('common.titlebar.minimize')} icon={Minus} onClick={() => appWindow.minimize().catch(() => {})} />
        <WindowButton
          label={t(maximized ? 'common.titlebar.restore' : 'common.titlebar.maximize')}
          icon={Square}
          onClick={() => appWindow.toggleMaximize().catch(() => {})}
        />
        <WindowButton label={t('common.titlebar.close')} icon={X} onClick={() => appWindow.close().catch(() => {})} danger />
      </div>
    </header>
  );
}
