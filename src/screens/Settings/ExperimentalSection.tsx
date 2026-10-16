import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { errorText } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { hasBackend } from '@/lib/tauri';
import { useCutoutStatus, useRemoveCutoutFiles } from '@/queries/atelier';
import { confirm } from '@/store/confirm';
import { toast } from '@/store/toasts';
import { useDecalUi } from '../Atelier/decalUi';
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
        <CutoutFilesRow />
      </SettingGroup>
    </>
  );
}

/**
 * The background-removal files (ONNX Runtime and the isnet-anime model, downloaded on first use):
 * their size on this PC and Remove (asked first; not an undoable toast: they can be downloaded
 * again). Remove is off while a download or a cutout runs. A runtime that was in use this session
 * can only go when Livery restarts: the row says so.
 */
function CutoutFilesRow() {
  const { t } = useTranslation();
  const status = useCutoutStatus(hasBackend());
  const remove = useRemoveCutoutFiles();
  const busy = useDecalUi((s) => s.cutoutBusy) || remove.isPending;
  const s = status.data;
  if (!s) return null;
  const present = s.runtime || s.model || s.bytes > 0;
  const helper = s.pendingRemoval
    ? t('settings.experimental.cutoutPending')
    : present
      ? t('settings.experimental.cutoutSize', { size: formatBytes(s.bytes) })
      : t('settings.experimental.cutoutNone', { size: formatBytes(s.downloadBytes) });

  const onRemove = async () => {
    const ok = await confirm({
      title: t('settings.experimental.cutoutConfirmTitle'),
      body: t('settings.experimental.cutoutConfirmBody', { size: formatBytes(s.bytes) }),
      confirmLabel: t('settings.experimental.cutoutRemove'),
    });
    if (!ok) return;
    remove.mutate(undefined, {
      onSuccess: (next) => toast(next.pendingRemoval ? t('settings.experimental.cutoutPending') : t('settings.experimental.cutoutRemoved')),
      onError: (e) => toast(errorText(e, t)),
    });
  };

  return (
    <SettingRow label={t('settings.experimental.cutout')} helper={helper}>
      {({ labelId, helperId }) =>
        present && !s.pendingRemoval ? (
          <Button size={28} variant="danger" disabled={busy} aria-describedby={[labelId, helperId].filter(Boolean).join(' ')} onClick={() => void onRemove()}>
            {t('settings.experimental.cutoutRemove')}
          </Button>
        ) : null
      }
    </SettingRow>
  );
}
