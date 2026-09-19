import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConflictPolicy } from '@/types';
import { RadioCards } from './RadioCards';
import { SectionTitle } from './SettingRow';
import { useSettingsPatch } from './useSettingsPatch';

const POLICIES: readonly ConflictPolicy[] = ['ask', 'replace', 'copy', 'skip'];

/** Conflicts: what an install does when its folder is taken (the queue and the watcher read it). */
export function ConflictsSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const titleId = useId();
  const introId = useId();
  return (
    <>
      <SectionTitle id={titleId} intro={t('settings.conflicts.intro')} introId={introId}>
        {t('settings.nav.conflicts')}
      </SectionTitle>
      <RadioCards
        labelledBy={titleId}
        describedBy={introId}
        value={settings.conflictPolicy}
        options={POLICIES.map((value) => ({ value, label: t(`settings.conflicts.policy.${value}`) }))}
        onChange={(conflictPolicy) => patch({ conflictPolicy })}
      />
    </>
  );
}
