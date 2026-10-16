import { Info } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import { Switch } from '@/components/ui/Switch';
import { bodyEnabled, missingHqPack, offersHighQuality, partRows, slotLabel, type PartRow } from './editorModel';
import { PANEL_LABEL } from './LayersPanel';

/**
 * The vehicle's paintable textures (slots) with an on/off switch each: its own parts first (body,
 * turret, gun…), then the shared ones (machine guns, nets, tracks…) under their own heading; the
 * High quality body option (when the body texture is below 4096, off while the body isn't
 * painted) and a note when the game's high-quality textures aren't installed. These are project
 * settings: saved, not part of the undo history.
 */
export function PartsList({ model }: { model: VehicleModelData }) {
  const { t } = useTranslation();
  const project = useAtelierEditor((s) => s.project);
  const setHighQuality = useAtelierEditor((s) => s.setHighQuality);
  const hqId = useId();
  const hqHelpId = useId();
  const sharedId = useId();
  if (!project) return null;
  const rows = partRows(project, model);
  const main = rows.filter((r) => r.main);
  const shared = rows.filter((r) => !r.main);
  const body = bodyEnabled(project);

  return (
    <section aria-labelledby="atelier-parts-title" className="flex flex-col gap-2 border-t border-line-2 px-4 pb-5 pt-4">
      <h2 id="atelier-parts-title" className={PANEL_LABEL}>
        {t('atelier.parts.title')}
      </h2>
      <PartSwitches rows={main} />
      {shared.length > 0 && (
        <>
          <h3 id={sharedId} className="px-2 pt-1 text-meta text-ink-4">
            {t('atelier.parts.shared')}
          </h3>
          <PartSwitches rows={shared} labelledBy={sharedId} />
        </>
      )}
      {offersHighQuality(model) && (
        <div className="flex flex-col gap-1 border-t border-line-1 px-2 pt-3">
          <div className="flex items-center justify-between gap-3">
            <span id={hqId} className={body ? 'text-body text-ink-2' : 'text-body text-ink-4'}>
              {t('atelier.parts.hq')}
            </span>
            <Switch
              checked={project.output.highQuality && body}
              disabled={!body}
              onChange={setHighQuality}
              aria-labelledby={hqId}
              aria-describedby={hqHelpId}
            />
          </div>
          <p id={hqHelpId} className="text-meta text-ink-4">
            {body ? t('atelier.parts.hqHelper') : t('atelier.parts.hqNeedsBody')}
          </p>
        </div>
      )}
      {missingHqPack(project, model) && (
        <p className="flex gap-2 rounded-ctl border border-line-2 bg-bg-2 px-2.5 py-2 text-meta text-ink-3">
          <Info size={14} strokeWidth={1.75} aria-hidden className="mt-px flex-none text-ink-4" />
          {t('atelier.parts.noHq')}
        </p>
      )}
    </section>
  );
}

function PartSwitches({ rows, labelledBy }: { rows: PartRow[]; labelledBy?: string }) {
  const { t } = useTranslation();
  const setSlotEnabled = useAtelierEditor((s) => s.setSlotEnabled);
  return (
    <ul className="flex flex-col" aria-labelledby={labelledBy}>
      {rows.map((row) => {
        const label = slotLabel(row.texture, t);
        return (
          <li key={row.texture} className="flex h-[34px] items-center justify-between gap-3 px-2">
            <span className="min-w-0 truncate text-body text-ink-2" title={row.texture}>
              {label}
            </span>
            <Switch checked={row.enabled} onChange={(on) => setSlotEnabled(row.texture, on)} label={t('atelier.parts.paint', { part: label })} />
          </li>
        );
      })}
    </ul>
  );
}
