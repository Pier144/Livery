import { useTranslation } from 'react-i18next';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/** M1 placeholder; Settings lands in M6. */
export function Settings() {
  const { t } = useTranslation();
  return (
    <ScreenFrame label={t('settings.title')}>
      <ScreenHeader title={t('settings.title')} meta={t('common.comingIn', { milestone: 'M6' })} />
    </ScreenFrame>
  );
}
