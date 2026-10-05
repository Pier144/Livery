import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@/components/ui/Kbd';
import { SegmentedControl, type Segment } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { errorText } from '@/lib/errors';
import { isTauri, toAppError } from '@/lib/tauri';
import { useSettings } from '@/queries/settings';
import { toast } from '@/store/toasts';
import type { ReduceMotion, Settings } from '@/types';
import { SectionTitle, SettingGroup, SettingRow } from './SettingRow';
import { useSettingsPatch } from './useSettingsPatch';

const MOTION: readonly ReduceMotion[] = ['system', 'on', 'off'];
const SHORTCUTS = ['search', 'sections', 'sidebar', 'undo', 'close'] as const;

/**
 * Start with Windows. `settings.startWithWindows` is the stored intent; the autostart plugin (the
 * Windows Run entry) is the truth.
 *
 * - When General opens, the two are reconciled once: if they disagree (Livery was turned off in Task
 *   Manager's Startup apps, or a save failed after the entry changed) the plugin wins and the setting
 *   is corrected.
 *   This runs here rather than at app start because nothing else reads the setting, so there is no
 *   reason to touch the registry on every launch.
 * - Toggling calls enable/disable first and saves the setting only once that worked; a failure
 *   shows a toast and the switch goes back to where it was. A call that fails although the entry
 *   already is in the wanted state (disable with no Run entry left: "file not found") counts as done.
 * - Outside the desktop app (browser dev, the mock backend) the switch only saves the setting.
 */
function useStartWithWindows(settings: Settings, patch: (changes: Partial<Settings>) => void) {
  const { t } = useTranslation();
  const { data: saved } = useSettings();
  // The value being applied while enable/disable runs; null when idle.
  const [pending, setPending] = useState<boolean | null>(null);
  const busy = useRef(false);
  const reconciled = useRef(false);
  // Set by a toggle: it already made the plugin and the setting agree, so an older read must not win.
  const toggled = useRef(false);
  const mounted = useRef(false);
  const patchRef = useRef(patch);
  patchRef.current = patch;

  // Its own effect so StrictMode's mount → unmount → mount leaves it true (a cleanup tied to the
  // reconcile effect would cancel the only check, since `reconciled` survives the remount).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Wait for the saved settings, then check once per visit.
    if (!saved || reconciled.current || !isTauri()) return;
    reconciled.current = true;
    const stored = saved.startWithWindows;
    void (async () => {
      try {
        const { isEnabled } = await import('@tauri-apps/plugin-autostart');
        const actual = await isEnabled();
        if (mounted.current && !toggled.current && actual !== stored) patchRef.current({ startWithWindows: actual });
      } catch (e) {
        // The switch keeps showing the stored intent; toggling will report a real failure.
        console.warn('[livery] reading Start with Windows failed', e);
      }
    })();
  }, [saved]);

  const toggle = async (next: boolean) => {
    if (busy.current) return;
    toggled.current = true;
    if (!isTauri()) {
      patch({ startWithWindows: next });
      return;
    }
    busy.current = true;
    setPending(next);
    try {
      const plugin = await import('@tauri-apps/plugin-autostart');
      try {
        await (next ? plugin.enable() : plugin.disable());
      } catch (e) {
        if ((await plugin.isEnabled().catch(() => !next)) !== next) throw e;
      }
      patch({ startWithWindows: next });
    } catch (e) {
      // Nothing changed, so a read still in flight is right again.
      toggled.current = false;
      toast(t('settings.general.autostartFailed', { message: errorText(toAppError(e), t) }));
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  return { checked: pending ?? settings.startWithWindows, busy: pending !== null, toggle };
}

/** General: Start with Windows, Reduce motion, shortcuts. */
export function GeneralSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const autostart = useStartWithWindows(settings, patch);
  const motion: Segment<ReduceMotion>[] = MOTION.map((value) => ({ value, label: t(`settings.general.motion.${value}`) }));

  return (
    <>
      <SectionTitle>{t('settings.nav.general')}</SectionTitle>
      <SettingGroup>
        <SettingRow label={t('settings.general.autostart')} helper={t('settings.general.autostartHelper')}>
          {({ labelId, helperId }) => (
            <Switch
              checked={autostart.checked}
              onChange={(next) => void autostart.toggle(next)}
              aria-busy={autostart.busy || undefined}
              aria-labelledby={labelId}
              aria-describedby={helperId}
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
