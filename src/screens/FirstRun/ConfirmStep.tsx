import { useEffect, useId, useRef, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { isTauri, toAppError } from '@/lib/tauri';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import type { GameDetection } from '@/types';
import { shortVersion, type ConfirmView } from './firstRunMachine';
import { StepIntro } from './StepTracker';

/** 13px underlined text button ("Skip for now", "Back", "Back to Settings"). */
const TEXT_LINK =
  'text-body leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120';
/** Controls stay focusable while an action runs; clicks are ignored instead. */
const BUSY = 'aria-disabled:cursor-default aria-disabled:opacity-50';

interface ConfirmStepProps {
  view: ConfirmView;
  detection: GameDetection | null;
  showPath: boolean;
  invalidFolder: boolean;
  /** A backend call or the finish is in flight. */
  busy: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onTogglePath: () => void;
  /** Found view: use the detected install. */
  onUse: () => void;
  onChooseAnother: () => void;
  /** Not-found view: a folder picked in the dialog or dropped on the window. */
  onFolder: (path: string) => void;
  onSkip: () => void;
  onBack: () => void;
  /**
   * Set when Settings opened First run (Settings → Game → Change): the not-found view then offers a
   * single "Back to Settings" (cancel: nothing changes) instead of "Skip for now" and "Back".
   */
  onCancel?: () => void;
}

/** 02 CONFIRM: the detected install, or a folder picker when nothing was found. */
export function ConfirmStep(props: ConfirmStepProps) {
  return props.view === 'found' && props.detection?.found ? <FoundView {...props} /> : <NotFoundView {...props} />;
}

function FoundView({ detection, showPath, busy, headingRef, onTogglePath, onUse, onChooseAnother }: ConfirmStepProps) {
  const { t } = useTranslation();
  const pathId = useId();
  const count = detection?.existingSkins ?? 0;
  const version = shortVersion(detection?.version);

  return (
    <>
      <StepIntro headingRef={headingRef} title={t('firstRun.found.title')} body={t('firstRun.found.body')} />
      <div className="flex flex-col gap-2 rounded-card border border-amber-60 bg-bg-3 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-medium leading-[normal]">{t('firstRun.found.game')}</span>
          <span className="rounded-tag border border-line-3 px-1.5 py-px font-mono text-[10px] leading-[normal] text-ink-2">
            {t(`common.status.source.${detection?.source ?? 'custom'}`)}
          </span>
        </div>
        <p className="text-meta leading-[normal] text-ink-3">
          {version ? t('firstRun.found.meta', { version, count }) : t('firstRun.found.metaNoVersion', { count })}
        </p>
        {/* Paths are hidden by default everywhere; "Show path" reveals the game root. */}
        <p id={pathId} hidden={!showPath} data-selectable className="break-all font-mono text-mono-sm leading-[normal] text-ink-4">
          {detection?.path}
        </p>
        <button
          type="button"
          onClick={onTogglePath}
          aria-expanded={showPath}
          aria-controls={pathId}
          className="self-start text-meta leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
        >
          {showPath ? t('common.hidePath') : t('common.showPath')}
        </button>
      </div>
      <div className="flex items-center gap-2.5">
        <Button variant="primary" size={34} onClick={onUse} aria-disabled={busy || undefined} className={BUSY}>
          {t('firstRun.found.use')}
        </Button>
        <Button variant="secondary" size={34} onClick={onChooseAnother} aria-disabled={busy || undefined} className={BUSY}>
          {t('firstRun.found.other')}
        </Button>
      </div>
    </>
  );
}

function NotFoundView({ invalidFolder, busy, headingRef, onFolder, onSkip, onBack, onCancel }: ConfirmStepProps) {
  const { t } = useTranslation();
  const errorId = useId();
  // Window drops and the dialog both land on the latest handler.
  const onFolderRef = useRef(onFolder);
  onFolderRef.current = onFolder;

  // While this view is shown, a folder dropped anywhere on the window is the game folder.
  useEffect(() => {
    const ui = useUi.getState();
    ui.setFolderDrop((paths) => {
      const [first] = paths;
      if (first) onFolderRef.current(first);
    });
    return () => useUi.getState().setFolderDrop(null);
  }, []);

  const pick = async () => {
    if (busy || !isTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, title: t('firstRun.notFound.pickerTitle') });
      if (typeof picked === 'string') onFolderRef.current(picked);
    } catch (e) {
      toast(toAppError(e).message);
    }
  };

  return (
    <>
      <StepIntro headingRef={headingRef} title={t('firstRun.notFound.title')} body={t('firstRun.notFound.body')} />
      <button
        type="button"
        onClick={() => void pick()}
        aria-busy={busy || undefined}
        aria-describedby={invalidFolder ? errorId : undefined}
        className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-line-4 bg-bg-input p-[26px] text-ink-1 hover:border-amber hover:bg-bg-3 motion-safe:transition-colors motion-safe:duration-120"
      >
        <span className="text-[14px] font-medium leading-[normal]">{t('firstRun.notFound.choose')}</span>
        <span className="text-meta leading-[normal] text-ink-4">{t('firstRun.notFound.drop')}</span>
      </button>
      {invalidFolder && (
        <p id={errorId} role="alert" className="flex items-start gap-2 text-meta text-ink-2">
          <span aria-hidden className="mt-[5px] h-1.5 w-1.5 flex-none rounded-full bg-amber" />
          {t('firstRun.notFound.invalid')}
        </p>
      )}
      <div className="flex items-center gap-3.5">
        {onCancel ? (
          <button type="button" onClick={onCancel} aria-disabled={busy || undefined} className={`${TEXT_LINK} ${BUSY}`}>
            {t('firstRun.notFound.backToSettings')}
          </button>
        ) : (
          <>
            <button type="button" onClick={onSkip} aria-disabled={busy || undefined} className={`${TEXT_LINK} ${BUSY}`}>
              {t('firstRun.notFound.skip')}
            </button>
            <button type="button" onClick={onBack} aria-disabled={busy || undefined} className={`${TEXT_LINK} ${BUSY}`}>
              {t('firstRun.notFound.back')}
            </button>
          </>
        )}
      </div>
    </>
  );
}
