import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REPO_URL, openLink } from '@/lib/opener';
import { IS_LINUX } from '@/lib/platform';
import { openFeedback } from '@/store/feedback';
import { LicensesDialog } from './LicensesDialog';
import { SectionTitle } from './SettingRow';
import { useAppVersion } from './useAppVersion';

/** 12px amber text link (prototype). */
const LINK =
  'text-meta leading-[normal] text-amber underline underline-offset-[3px] hover:text-amber-hover motion-safe:transition-colors motion-safe:duration-120';

/**
 * About: brand, description, the unofficial-tool line, what Livery connects to (privacy) and links.
 * Source code opens Livery's GitHub repository in the default browser (`@/lib/opener`; if the
 * browser can't be opened the link goes to the clipboard); Send feedback opens FeedbackDialog.
 * No Gaijin / War Thunder logos anywhere.
 */
export function AboutSection() {
  const { t } = useTranslation();
  const version = useAppVersion();
  const [licensesOpen, setLicensesOpen] = useState(false);

  return (
    <>
      <SectionTitle>{t('settings.nav.about')}</SectionTitle>
      <div className="flex flex-col gap-3.5 text-body leading-[1.6] text-ink-2">
        <div className="flex items-center gap-3">
          <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full bg-amber shadow-glow-lg" />
          <span className="text-[14px] font-semibold leading-[normal] tracking-[.14em]">{t('common.brand')}</span>
          <span className="font-mono text-mono-sm leading-[normal] text-ink-4">{t(IS_LINUX ? 'settings.about.buildLinux' : 'settings.about.build', { version })}</span>
        </div>
        <p>{t('settings.about.description')}</p>
        <p className="rounded-card border border-line-2 bg-bg-3 px-3.5 py-3 text-ink-3">{t('common.unofficial')}</p>
        <section aria-labelledby="about-privacy" className="flex flex-col gap-1">
          <h3 id="about-privacy" className="font-mono text-mono-label uppercase text-ink-4">
            {t('settings.about.privacyTitle')}
          </h3>
          <p className="text-ink-3">{t('settings.about.privacy')}</p>
        </section>
        <div role="group" aria-label={t('settings.about.links')} className="flex flex-wrap gap-4">
          <button type="button" title={t('settings.about.sourceHint')} onClick={() => void openLink(REPO_URL, t)} className={LINK}>
            {t('settings.about.source')}
          </button>
          <button type="button" aria-haspopup="dialog" title={t('settings.about.feedbackHint')} onClick={openFeedback} className={LINK}>
            {t('settings.about.feedback')}
          </button>
          <button type="button" aria-haspopup="dialog" onClick={() => setLicensesOpen(true)} className={LINK}>
            {t('settings.about.licenses')}
          </button>
        </div>
      </div>
      {licensesOpen && <LicensesDialog onClose={() => setLicensesOpen(false)} />}
    </>
  );
}
