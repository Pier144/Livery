import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { useUi } from '@/store/ui';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/** M1 placeholder: the library index arrives in M3, so the hangar is empty. */
export function Hangar() {
  const { t } = useTranslation();
  const go = useUi((s) => s.go);
  return (
    <ScreenFrame label={t('hangar.title')}>
      <ScreenHeader title={t('hangar.title')} meta={t('common.comingIn', { milestone: 'M3' })} />
      <EmptyState
        title={t('hangar.emptyTitle')}
        body={t('hangar.emptyBody')}
        primary={{ label: t('hangar.emptyAction'), onClick: () => go('explore') }}
      />
    </ScreenFrame>
  );
}
