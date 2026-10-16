import { useTranslation } from 'react-i18next';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/**
 * Atelier, the skin editor (Settings → Experimental → Atelier). Placeholder until the home and
 * the editor land: the screen frame and its heading.
 */
export function Atelier() {
  const { t } = useTranslation();
  return (
    <ScreenFrame label={t('common.nav.atelier')}>
      <ScreenHeader title={t('common.nav.atelier')} />
    </ScreenFrame>
  );
}
