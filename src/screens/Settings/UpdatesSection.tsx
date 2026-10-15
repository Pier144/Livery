import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { errorText } from '@/lib/errors';
import { useUpdate } from '@/store/update';
import { SectionTitle, SettingGroup, SettingRow, UNAVAILABLE, type RowIds } from './SettingRow';
import { useAppVersion } from './useAppVersion';
import { useSettingsPatch } from './useSettingsPatch';

/**
 * Updates: the version and what the update feed says, with "Check now", then "Install and restart"
 * (or "Restart and update" once a background download is ready); "Install updates automatically"
 * downloads new versions in the background and installs them when Livery closes.
 */
export function UpdatesSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const version = useAppVersion();
  const { phase, latest, pct, requested, error, check, install } = useUpdate();
  const next = latest ?? '';

  let label: string;
  let helper: string | undefined;
  let control: ((ids: RowIds) => ReactNode) | undefined;

  const checkButton = ({ helperId }: RowIds) => (
    <Button
      variant="secondary"
      size={28}
      onClick={() => void check()}
      aria-disabled={phase === 'checking' || undefined}
      aria-describedby={helperId}
      className={`${UNAVAILABLE} aria-disabled:hover:border-line-3`}
    >
      {t('settings.updates.check')}
    </Button>
  );

  switch (phase) {
    case 'available':
      label = t('settings.updates.available', { version: next });
      helper = t('settings.updates.availableHelper', { current: version });
      control = ({ helperId }) => (
        <Button variant="primary" size={28} onClick={() => void install()} aria-describedby={helperId}>
          {t('settings.updates.install')}
        </Button>
      );
      break;
    case 'downloading':
      label = t('settings.updates.downloading', { version: next });
      helper = requested ? t('settings.updates.downloadingHelper') : t('settings.updates.downloadingBackground');
      control = ({ labelId }) => <Progress pct={pct} labelId={labelId} />;
      break;
    case 'ready':
      label = t('settings.updates.ready', { version: next });
      helper = settings.autoUpdate ? t('settings.updates.readyHelper') : t('settings.updates.readyManualHelper');
      control = ({ helperId }) => (
        <Button variant="primary" size={28} onClick={() => void install()} aria-describedby={helperId}>
          {t('settings.updates.restart')}
        </Button>
      );
      break;
    case 'installing':
      label = t('settings.updates.installing', { version: next });
      helper = t('settings.updates.installingHelper');
      break;
    case 'upToDate':
      label = t('settings.updates.upToDate', { version });
      control = checkButton;
      break;
    case 'checking':
      label = t('settings.updates.version', { version });
      helper = t('settings.updates.checking');
      control = checkButton;
      break;
    case 'error':
      label = t('settings.updates.version', { version });
      helper = error ? errorText(error, t) : undefined;
      control = checkButton;
      break;
    default:
      label = t('settings.updates.version', { version });
      control = checkButton;
  }

  return (
    <>
      <SectionTitle>{t('settings.nav.updates')}</SectionTitle>
      <SettingGroup>
        <SettingRow label={<span role="status">{label}</span>} helper={helper}>
          {control}
        </SettingRow>
        <SettingRow label={t('settings.updates.auto')} helper={t('settings.updates.autoHelper')}>
          {({ labelId, helperId }) => (
            <Switch
              checked={settings.autoUpdate}
              onChange={(autoUpdate) => patch({ autoUpdate })}
              aria-labelledby={labelId}
              aria-describedby={helperId}
            />
          )}
        </SettingRow>
      </SettingGroup>
    </>
  );
}

/** Download progress: a 3px amber bar (sliding while the size is unknown) over the percentage. */
function Progress({ pct, labelId }: { pct: number | undefined; labelId: string }) {
  return (
    <div
      role="progressbar"
      aria-labelledby={labelId}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="flex w-40 flex-none flex-col gap-1.5"
    >
      <div className="h-[3px] overflow-hidden rounded-[2px] bg-bg-5">
        {pct === undefined ? (
          <div className="h-full w-2/5 bg-amber motion-safe:animate-indeterminate" />
        ) : (
          <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-linear" style={{ width: `${pct}%` }} />
        )}
      </div>
      {pct !== undefined && <span aria-hidden className="text-right font-mono text-[10px] leading-[normal] text-ink-3">{pct}%</span>}
    </div>
  );
}
