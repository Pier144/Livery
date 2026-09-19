import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { baseName } from '@/lib/format';
import { isTauri, toAppError } from '@/lib/tauri';
import { useWatchFolder } from '@/queries/queue';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { ROW_LINK, SectionTitle, SettingGroup, SettingRow } from './SettingRow';
import { useSettingsUi } from './settingsUi';
import { useSettingsPatch } from './useSettingsPatch';

/** A full path, hidden until "Show path" (paths are hidden by default everywhere). */
function RevealPath({ path, describedBy }: { path: string; describedBy: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const pathId = useId();
  return (
    <>
      <p id={pathId} hidden={!shown} data-selectable className="break-all font-mono text-mono-sm leading-[normal] text-ink-4">
        {path}
      </p>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-expanded={shown}
        aria-controls={pathId}
        aria-describedby={describedBy}
        className={`mt-1 ${ROW_LINK}`}
      >
        {shown ? t('common.hidePath') : t('common.showPath')}
      </button>
    </>
  );
}

/**
 * Game: the War Thunder install (Change → First run's folder picker, back here when done) and the
 * folder watched for new archives (Change → folder picker → `watch_folder`).
 */
export function GameSection() {
  const { t } = useTranslation();
  const { settings } = useSettingsPatch();
  const { mutateAsync: watchFolder } = useWatchFolder();
  const changeRef = useRef<HTMLButtonElement>(null);
  const gameLabelId = useId();
  const watchLabelId = useId();

  // Back from First run: focus returns to the button that went there.
  useEffect(() => {
    if (!useSettingsUi.getState().refocusGameChange) return;
    useSettingsUi.setState({ refocusGameChange: false });
    changeRef.current?.focus();
  }, []);

  const changeGame = () => {
    useSettingsUi.setState({ refocusGameChange: true });
    useUi.getState().startFirstRun({ step: 'choose', returnTo: 'settings' });
  };

  const changeWatched = async () => {
    // The folder picker needs the desktop app.
    if (!isTauri()) return;
    let path: string | null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, title: t('settings.game.watchPickTitle'), defaultPath: settings.watchFolder });
      path = typeof picked === 'string' ? picked : null;
    } catch (e) {
      toast(toAppError(e).message);
      return;
    }
    if (!path) return;
    try {
      // Watching stays on or off as it was; the reply (new settings) lands in the settings query.
      await watchFolder({ path, enabled: settings.autoInstall });
    } catch (e) {
      toast(toAppError(e).message);
    }
  };

  const gamePath = settings.gamePath;
  const watched = settings.watchFolder;

  return (
    <>
      <SectionTitle>{t('settings.nav.game')}</SectionTitle>
      <SettingGroup>
        {gamePath ? (
          <SettingRow
            labelId={gameLabelId}
            label={t('settings.game.game', { source: t(`settings.game.source.${settings.gameSource ?? 'custom'}`) })}
            details={<RevealPath path={gamePath} describedBy={gameLabelId} />}
          >
            {() => (
              <Button ref={changeRef} variant="secondary" size={28} onClick={changeGame} aria-describedby={gameLabelId}>
                {t('settings.game.change')}
              </Button>
            )}
          </SettingRow>
        ) : (
          <SettingRow label={t('settings.game.none')} helper={t('settings.game.noneHelper')}>
            {({ labelId }) => (
              <Button ref={changeRef} variant="secondary" size={28} onClick={changeGame} aria-describedby={labelId}>
                {t('settings.game.choose')}
              </Button>
            )}
          </SettingRow>
        )}
        <SettingRow
          labelId={watchLabelId}
          label={t('settings.game.watched')}
          helper={watched ? baseName(watched) : t('settings.game.downloadsDefault')}
          mono
          details={watched ? <RevealPath path={watched} describedBy={watchLabelId} /> : undefined}
        >
          {() => (
            <Button variant="secondary" size={28} onClick={() => void changeWatched()} aria-describedby={watchLabelId}>
              {t('settings.game.change')}
            </Button>
          )}
        </SettingRow>
      </SettingGroup>
    </>
  );
}
