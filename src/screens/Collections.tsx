import { useTranslation } from 'react-i18next';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/** M1 placeholder; Collections lands in M3. */
export function Collections() {
  const { t } = useTranslation();
  return (
    <ScreenFrame label={t('collections.title')}>
      <ScreenHeader title={t('collections.title')} meta={t('common.comingIn', { milestone: 'M3' })} />
    </ScreenFrame>
  );
}
