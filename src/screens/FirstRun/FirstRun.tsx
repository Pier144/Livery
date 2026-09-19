import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '@/lib/errors';
import { toAppError } from '@/lib/tauri';
import { detectGame, useImportSkins, useScanUserSkins, useSetGamePath } from '@/queries/game';
import { useUpdateSettings } from '@/queries/settings';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import type { GameSource } from '@/types';
import { ConfirmStep } from './ConfirmStep';
import { DetectStep } from './DetectStep';
import { TICK_MS, firstRunReducer, initialFirstRun, stepIndex } from './firstRunMachine';
import { ImportStep } from './ImportStep';
import { StepTracker } from './StepTracker';
import { TechAnimation } from './TechAnimation';

/**
 * First run (README §1): Detect → Confirm (found / not found) → Import, with the technical
 * drawing on the right. Finishing or skipping sets `onboarded` and opens `useUi.firstRun.returnTo`
 * (Explore for the onboarding). Settings → Game → Change starts it at `choose`: straight to the
 * folder picker without detecting, with "Back to Settings" (a cancel that changes nothing) in place
 * of "Skip for now" and "Back", and back to Settings when a folder is set.
 */
export function FirstRun() {
  const { t } = useTranslation();
  // Read once: the entry describes this run, whatever happens to the store meanwhile.
  const [entry] = useState(() => useUi.getState().firstRun);
  const [state, dispatch] = useReducer(firstRunReducer, entry.step, initialFirstRun);
  const setGamePath = useSetGamePath();
  const scan = useScanUserSkins();
  const importSkins = useImportSkins();
  const updateSettings = useUpdateSettings();
  const busy = setGamePath.isPending || importSkins.isPending || updateSettings.isPending;

  // Detection: results arrive in ms and are buffered; the tick below reveals them.
  // Every run id starts on Detect, except the first one of a `choose` entry (no detection on mount).
  useEffect(() => {
    if (state.step !== 'detect') return;
    let alive = true;
    detectGame((event) => {
      if (alive) dispatch({ type: 'detectEvent', event });
    })
      .then((detection) => {
        if (alive) dispatch({ type: 'detectDone', detection });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        toast(errorText(toAppError(e), t));
        dispatch({ type: 'detectFailed' });
      });
    return () => {
      alive = false;
    };
  }, [state.runId]);

  const detecting = state.step === 'detect';
  useEffect(() => {
    if (!detecting) return;
    const id = window.setInterval(() => dispatch({ type: 'tick' }), TICK_MS);
    return () => window.clearInterval(id);
  }, [detecting, state.runId]);

  // Each new step (or Confirm view) moves focus to its heading so screen readers hear it.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepKey = state.step === 'confirm' ? `confirm-${state.view}` : state.step;
  // A `choose` entry comes from Settings: focus its heading on arrival too (the Change button is gone).
  const shownKey = useRef<string | null>(entry.step === 'choose' ? null : stepKey);
  useEffect(() => {
    if (shownKey.current === stepKey) return;
    shownKey.current = stepKey;
    headingRef.current?.focus();
  }, [stepKey]);

  const finish = (message?: string) => {
    updateSettings.mutate(
      { onboarded: true },
      {
        onSuccess: () => {
          if (message) toast(message);
          useUi.getState().go(entry.returnTo);
        },
        onError: (e) => toast(errorText(e, t)),
      },
    );
  };

  const runScan = () =>
    scan.mutate(undefined, {
      onError: (e) => toast(errorText(e, t)),
    });

  /** `source` is the detected one; a picked or dropped folder has none (custom). */
  const applyFolder = (path: string, source?: GameSource) => {
    if (busy) return;
    const manual = source === undefined;
    if (manual) dispatch({ type: 'folderSubmitted' });
    setGamePath.mutate(
      { path, source },
      {
        onSuccess: (detection) => {
          if (manual) toast(t('firstRun.toast.gameSet'));
          if (detection.existingSkins > 0) {
            dispatch({ type: 'toImport' });
            runScan();
          } else {
            finish();
          }
        },
        onError: (e) => {
          if (manual && e.code === 'invalidInput') dispatch({ type: 'folderInvalid' });
          else toast(errorText(e, t));
        },
      },
    );
  };

  const runImport = () => {
    const skins = scan.data;
    if (busy || scan.isPending || !skins) return;
    if (skins.length === 0) return finish();
    importSkins.mutate(
      skins.map((s) => s.folder),
      {
        // import_skins returns the whole index: count only the folders asked for (folder names
        // match case-insensitively on Windows).
        onSuccess: (index) => {
          const wanted = new Set(skins.map((s) => s.folder.toLowerCase()));
          const count = index.filter((s) => wanted.has(s.folder.toLowerCase())).length;
          finish(t('firstRun.toast.imported', { count }));
        },
        onError: (e) => toast(errorText(e, t)),
      },
    );
  };

  const detection = state.detection;
  const outcome =
    state.step === 'detect' || !detection
      ? ''
      : detection.found
        ? t('firstRun.detect.doneFound', { source: t(`firstRun.detect.sources.${detection.source ?? 'custom'}`) })
        : t('firstRun.detect.doneNotFound');

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* my-auto centres vertically but still scrolls from the top when the window is short. */}
      <div className="flex min-h-0 max-w-[620px] flex-col overflow-y-auto px-[72px]">
        <div className="my-auto flex flex-col gap-7 py-6">
          <StepTracker current={stepIndex(state.step)} />
          {state.step === 'detect' && <DetectStep state={state} headingRef={headingRef} />}
          {state.step === 'confirm' && (
            <ConfirmStep
              view={state.view}
              detection={detection}
              showPath={state.showPath}
              invalidFolder={state.invalidFolder}
              busy={busy}
              headingRef={headingRef}
              onTogglePath={() => dispatch({ type: 'togglePath' })}
              onUse={() => detection?.path && applyFolder(detection.path, detection.source ?? 'custom')}
              onChooseAnother={() => !busy && dispatch({ type: 'chooseAnother' })}
              onFolder={(path) => applyFolder(path)}
              onSkip={() => !busy && finish(t('firstRun.toast.later'))}
              onBack={() => !busy && dispatch({ type: 'back' })}
              // From Settings: leave without touching anything (no detection, no settings write).
              onCancel={entry.step === 'choose' ? () => !busy && useUi.getState().go(entry.returnTo) : undefined}
            />
          )}
          {state.step === 'import' && (
            <ImportStep
              skins={scan.data}
              scanning={scan.isPending}
              scanFailed={scan.isError}
              busy={busy}
              headingRef={headingRef}
              onImport={runImport}
              onSkip={() => !busy && finish()}
              onRetry={runScan}
            />
          )}
        </div>
      </div>
      <div className="relative flex items-center justify-center overflow-hidden border-l border-line-grid">
        <TechAnimation />
      </div>
      <p role="status" className="sr-only">
        {outcome}
      </p>
    </div>
  );
}
