import { useTranslation } from 'react-i18next';
import { Kbd } from '@/components/ui/Kbd';
import { SegmentedControl, type Segment } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import type { ReduceMotion } from '@/types';
import { SectionTitle, SettingGroup, SettingRow } from './SettingRow';
import { useSettingsPatch } from './useSettingsPatch';

const MOTION: readonly ReduceMotion[] = ['system', 'on', 'off'];
const SHORTCUTS = ['search', 'sections', 'sidebar', 'undo', 'close'] as const;

const noop = () => {};

/** General: Start with Windows (needs the autostart plugin, not approved yet), Reduce motion, shortcuts. */
export function GeneralSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const motion: Segment<ReduceMotion>[] = MOTION.map((value) => ({ value, label: t(`settings.general.motion.${value}`) }));

  return (
    <>
      <SectionTitle>{t('settings.nav.general')}</SectionTitle>
      <SettingGroup>
        <SettingRow label={t('settings.general.autostart')} helper={t('settings.general.autostartPending')}>
          {({ labelId, helperId }) => (
            // Focusable while unavailable so the reason (the helper) is found with Tab too.
            <Switch
              checked={settings.startWithWindows}
              onChange={noop}
              aria-disabled
              aria-labelledby={labelId}
              aria-describedby={helperId}
              className="cursor-default opacity-50"
            />
          )}
        </SettingRow>
        <SettingRow label={t('settings.general.reduceMotion')} helper={t('settings.general.reduceMotionHelper')}>
          {({ helperId }) => (
            <SegmentedControl
              label={t('settings.general.reduceMotion')}
              value={settings.reduceMotion}
              options={motion}
              onChange={(reduceMotion) => patch({ reduceMotion })}
              aria-describedby={helperId}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.general.shortcuts')}
          helper={
            <ul className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {SHORTCUTS.map((key, i) => (
                // The spaces are for the text (screen readers, copy); the flex gap does the layout.
                <li key={key} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden>{' · '}</span>}
                  <Kbd>{t(`settings.general.keys.${key}`)}</Kbd>{' '}
                  <span>{t(`settings.general.actions.${key}`)}</span>
                </li>
              ))}
            </ul>
          }
        />
      </SettingGroup>
    </>
  );
}
