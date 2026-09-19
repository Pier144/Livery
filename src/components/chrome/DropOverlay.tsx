import { useTranslation } from 'react-i18next';
import { useUi } from '@/store/ui';

/**
 * "Drop to add" overlay shown while files are dragged over the window.
 * Purely visual (pointer-events-none): the drop itself is handled by `useFileDrop`.
 */
export function DropOverlay() {
  const { t } = useTranslation();
  const active = useUi((s) => s.dragActive);

  // The live region stays mounted so assistive tech announces the overlay when it appears.
  return (
    <div role="status">
      {active && (
        <div className="pointer-events-none fixed inset-2 z-[60] flex items-center justify-center rounded-dialog border-2 border-dashed border-amber bg-bg-scrim">
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-title text-ink-1">{t('common.drop.title')}</span>
            <span className="font-mono text-mono-sm text-ink-3">{t('common.drop.formats')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
