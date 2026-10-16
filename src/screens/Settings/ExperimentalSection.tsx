import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/Switch';
import { ROW_LINK, SectionTitle, SettingGroup, SettingRow } from './SettingRow';
import { openSettingsAt } from './settingsUi';
import { useSettingsPatch } from './useSettingsPatch';

/**
 * Experimental: features that may still change or break. Atelier (the skin editor) shows in the
 * sidebar while its switch is on; it reads the vehicles' models from the game, so with Game →
 * Read data from the game off the row says so and links to that setting.
 */
export function ExperimentalSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const needsId = useId();
  const needsGameData = !settings.readGameData;

  return (
    <>
      <SectionTitle>{t('settings.experimental.title')}</SectionTitle>
      <SettingGroup>
        <SettingRow
          label={t('settings.experimental.atelier')}
          helper={t('settings.experimental.atelierHelper')}
          details={
            needsGameData && (
              <div className="flex flex-col gap-1 pt-1.5">
                <p id={needsId} className="text-[11px] leading-[normal] text-ink-3">
                  {t('settings.experimental.needsGameData')}
                </p>
                <button type="button" onClick={() => openSettingsAt('game')} className={ROW_LINK}>
                  {t('settings.experimental.openGame')}
                </button>
              </div>
            )
          }
        >
          {({ labelId, helperId }) => (
            <Switch
              checked={settings.atelierEnabled}
              onChange={(next) => patch({ atelierEnabled: next })}
              aria-labelledby={labelId}
              aria-describedby={[helperId, needsGameData ? needsId : undefined].filter(Boolean).join(' ') || undefined}
            />
          )}
        </SettingRow>
      </SettingGroup>
    </>
  );
}
