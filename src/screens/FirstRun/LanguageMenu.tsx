import { ChevronDown, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Menu } from '@/components/ui/Menu';
import { LANGUAGES } from '@/i18n';
import { errorText } from '@/lib/errors';
import { useSettings, useUpdateSettings } from '@/queries/settings';
import { toast } from '@/store/toasts';
import type { Language } from '@/types';

/**
 * First run language switch: the same setting as Settings → Language, so a player who does not read
 * the detected language can change it before anything else. The UI switches as soon as the setting
 * is saved (`useLanguageSync`).
 */
export function LanguageMenu() {
  const { t } = useTranslation();
  const { data } = useSettings();
  const update = useUpdateSettings();
  // The choice in flight shows at once; a failed save falls back to the saved language.
  const current: Language = (update.isPending ? update.variables?.language : undefined) ?? data?.language ?? 'en';
  const name = (l: Language) => t(`settings.language.names.${l}`);

  return (
    <Menu
      kind="radio"
      align="end"
      label={t('firstRun.language')}
      value={current}
      // Each language is named in itself (endonym) and marked with its language.
      items={LANGUAGES.map((l) => ({ value: l, label: <span lang={l}>{name(l)}</span>, textValue: name(l) }))}
      onSelect={(value) => {
        const language = value as Language;
        if (language === current) return;
        update.mutate({ language }, { onError: (e) => toast(errorText(e, t)) });
      }}
      renderTrigger={(props) => (
        <button
          {...props}
          aria-label={`${t('firstRun.language')}: ${name(current)}`}
          className="flex h-ctl items-center gap-2 whitespace-nowrap rounded-ctl border border-line-3 bg-bg-chip px-2.5 text-meta leading-[normal] text-ink-1 hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120"
        >
          <Languages size={14} strokeWidth={1.75} aria-hidden className="text-ink-3" />
          <span lang={current}>{name(current)}</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="text-ink-3" />
        </button>
      )}
    />
  );
}
