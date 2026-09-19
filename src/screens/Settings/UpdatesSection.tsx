import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { SectionTitle, SettingGroup, SettingRow, UNAVAILABLE } from './SettingRow';
import { useAppVersion } from './useAppVersion';
import { useSettingsPatch } from './useSettingsPatch';

const noop = () => {};

/**
 * Updates: the version, with "Check now" and "Install updates automatically" unavailable until the
 * updater plugin is approved (the switch keeps showing `settings.autoUpdate`).
 */
export function UpdatesSection() {
  const { t } = useTranslation();
  const { settings } = useSettingsPatch();
  const version = useAppVersion();
  const pendingId = useId();
  return (
    <>
      <SectionTitle>{t('settings.nav.updates')}</SectionTitle>
      <SettingGroup>
        <SettingRow label={t('settings.updates.version', { version })} helper={t('settings.updates.pending')} helperId={pendingId}>
          {() => (
            <Button
              variant="secondary"
              size={28}
              onClick={noop}
              aria-disabled
              aria-describedby={pendingId}
              className={`${UNAVAILABLE} aria-disabled:hover:border-line-3`}
            >
              {t('settings.updates.check')}
            </Button>
          )}
        </SettingRow>
        <SettingRow label={t('settings.updates.auto')}>
          {({ labelId }) => (
            <Switch
              checked={settings.autoUpdate}
              onChange={noop}
              aria-disabled
              aria-labelledby={labelId}
              aria-describedby={pendingId}
              className="cursor-default opacity-50"
            />
          )}
        </SettingRow>
      </SettingGroup>
    </>
  );
}
