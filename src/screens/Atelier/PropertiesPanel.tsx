import { Plus, Shuffle, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import {
  baseOf,
  CELL_SIZE_MAX,
  CELL_SIZE_MIN,
  DEFAULT_CAMO_COLOR,
  DEFAULT_STRIPE_ANGLE,
  STRIPE_ANGLE_MAX,
  STRIPE_ANGLE_MIN,
  maskOf,
  MAX_CAMO_COLORS,
  MIN_CAMO_COLORS,
  isDecalLayer,
  type BaseLayer,
  type BaseMode,
  type Decal,
  type Layer,
  type PartFilter,
} from '@/atelier/project';
import { Button } from '@/components/ui/Button';
import { ChipDropdown } from '@/components/ui/ChipDropdown';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { PartGroup } from '@/types';
import { CamoSharesBar, CamoStylePicker, camoPatternOf } from './CamoControls';
import { ColorSwatch, Field, Slider } from './controls';
import { DecalProperties } from './DecalProperties';
import {
  BRUSH_MAX,
  BRUSH_MIN,
  MASK_ROW_ID,
  nextCamoColor,
  SCALE_MAX,
  SCALE_MIN,
  shuffledSeed,
  weightsWithColorAdded,
  weightsWithColorRemoved,
} from './editorModel';
import { PANEL_LABEL, useLayerName } from './LayersPanel';

/** The brush as the panel edits it (`size` is a fraction of the model's radius). */
export interface BrushUi {
  size: number;
  hardness: number;
  erase: boolean;
  part: PartFilter;
}

interface PropertiesPanelProps {
  brush: BrushUi;
  onBrush: (patch: Partial<BrushUi>) => void;
  /** Whether a layer's decal lands on shared texels (Mirror is then offered off). */
  checkShared: (layerId: string, decal?: Decal) => Promise<boolean>;
  onRemoveBackground: (layerId: string) => void;
  onRefineEdge: (layerId: string) => void;
}

/**
 * The selected layer's properties: the Base's paint, the Protected areas' brush, an image or text
 * layer's settings, or a note for layers this version can't edit.
 */
export function PropertiesPanel({ brush, onBrush, checkShared, onRemoveBackground, onRefineEdge }: PropertiesPanelProps) {
  const { t } = useTranslation();
  const layers = useAtelierEditor((s) => s.layers);
  const selectedId = useAtelierEditor((s) => s.selectedId);
  const nameOf = useLayerName();
  const mask = maskOf(layers);
  const selected: Layer | undefined = layers.find((l) => l.id === selectedId);
  const maskSelected = selectedId === MASK_ROW_ID || (selected !== undefined && selected.kind === 'mask');
  const base = baseOf(layers);

  let title: string;
  let body: ReactNode;
  if (maskSelected) {
    title = nameOf(mask, 'mask');
    body = <MaskProperties brush={brush} onBrush={onBrush} hidden={mask !== undefined && !mask.visible} strokes={mask?.strokes.length ?? 0} />;
  } else if (isDecalLayer(selected)) {
    title = nameOf(selected, selected.kind);
    body = <DecalProperties layer={selected} checkShared={checkShared} onRemoveBackground={onRemoveBackground} onRefineEdge={onRefineEdge} />;
  } else if (selected?.kind === 'unsupported') {
    title = nameOf(selected, 'unsupported');
    body = <p className="text-body text-ink-3">{t('atelier.props.unsupported')}</p>;
  } else if (base) {
    title = nameOf(base, 'base');
    body = <BaseProperties base={base} />;
  } else {
    return null;
  }

  return (
    <section aria-labelledby="atelier-props-title" className="flex min-h-0 flex-col gap-4.5 overflow-y-auto border-l border-line-2 bg-bg-1 p-5">
      <div className="flex flex-col gap-1">
        <h2 className={PANEL_LABEL}>{t('atelier.props.title')}</h2>
        <p id="atelier-props-title" className="truncate text-card text-ink-1">
          {title}
        </p>
      </div>
      {body}
    </section>
  );
}

// ── Base ────────────────────────────────────────────────────────────────────

function BaseProperties({ base }: { base: BaseLayer }) {
  const { t } = useTranslation();
  const setBase = useAtelierEditor((s) => s.setBase);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  const camo = base.mode === 'camo';
  const shown = camo ? base.colors : base.colors.slice(0, 1);
  const pattern = camoPatternOf(base);
  const grid = pattern === 'digital' || pattern === 'hex' || pattern === 'triangles';

  const setMode = (mode: BaseMode) => {
    if (mode === base.mode) return;
    const add = mode === 'camo' && base.colors.length < MIN_CAMO_COLORS;
    const colors = add ? [...base.colors, DEFAULT_CAMO_COLOR] : base.colors;
    setBase({ mode, colors, weights: add ? weightsWithColorAdded(base.weights) : base.weights });
  };

  const setColor = (i: number, hex: string) => {
    const colors = [...base.colors];
    colors[i] = hex.toLowerCase();
    setBase({ colors }, `color-${i}`);
  };

  return (
    <>
      <Field label={t('atelier.props.mode')}>
        {(id) => (
          <SegmentedControl
            label={t('atelier.props.mode')}
            aria-describedby={id}
            value={base.mode}
            options={[
              { value: 'solid', label: t('atelier.props.solid') },
              { value: 'camo', label: t('atelier.props.camo') },
            ]}
            onChange={setMode}
            className="self-start"
          />
        )}
      </Field>

      {camo && (
        <Field label={t('atelier.props.camoStyle')}>
          {(id) => <CamoStylePicker base={base} labelId={id} onChange={(next) => setBase({ pattern: next })} />}
        </Field>
      )}

      <Field label={camo ? t('atelier.props.colors') : t('atelier.props.color')}>
        {() => (
          <div className="flex flex-wrap items-center gap-2">
            {shown.map((color, i) => (
              <div key={i} className="group relative">
                <ColorSwatch
                  value={color}
                  label={t('atelier.props.colorN', { n: i + 1 })}
                  onInput={(hex) => setColor(i, hex)}
                  onCommit={endGesture}
                />
                {camo && base.colors.length > MIN_CAMO_COLORS && (
                  <button
                    type="button"
                    onClick={() => setBase({ colors: base.colors.filter((_, k) => k !== i), weights: weightsWithColorRemoved(base.weights, i) })}
                    aria-label={t('atelier.props.removeColor', { n: i + 1 })}
                    title={t('atelier.props.removeColor', { n: i + 1 })}
                    className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full border border-line-3 bg-bg-5 text-ink-3 opacity-0 hover:text-ink-1 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X size={10} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {camo && base.colors.length < MAX_CAMO_COLORS && (
              <button
                type="button"
                onClick={() => setBase({ colors: [...base.colors, nextCamoColor(base.colors)], weights: weightsWithColorAdded(base.weights) })}
                aria-label={t('atelier.props.addColor')}
                title={t('atelier.props.addColor')}
                className="grid h-8 w-8 place-items-center rounded-ctl border border-dashed border-line-4 text-ink-3 hover:border-ink-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
              >
                <Plus size={14} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </div>
        )}
      </Field>

      {camo && (
        <>
          <Field label={t('atelier.props.shares')}>
            {(id) => (
              <div className="flex flex-col gap-1.5">
                <CamoSharesBar base={base} labelId={id} onChange={(weights) => setBase({ weights }, 'shares')} onCommit={endGesture} />
                {base.weights && (
                  <button type="button" onClick={() => setBase({ weights: undefined })} className="self-start text-meta text-ink-3 underline-offset-2 hover:text-ink-1 hover:underline">
                    {t('atelier.props.sharesEqual')}
                  </button>
                )}
              </div>
            )}
          </Field>
          <Slider
            label={t('atelier.props.scale')}
            value={base.scale}
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(scale) => setBase({ scale }, 'scale')}
            onCommit={endGesture}
          />
          {grid && (
            <Slider
              label={t('atelier.props.cellSize')}
              value={base.cellSize ?? 1}
              min={CELL_SIZE_MIN}
              max={CELL_SIZE_MAX}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(cellSize) => setBase({ cellSize }, 'cellSize')}
              onCommit={endGesture}
            />
          )}
          {pattern === 'stripes' && (
            <Slider
              label={t('atelier.props.angle')}
              value={base.angle ?? DEFAULT_STRIPE_ANGLE}
              min={STRIPE_ANGLE_MIN}
              max={STRIPE_ANGLE_MAX}
              step={1}
              format={(v) => `${Math.round(v)}°`}
              onChange={(angle) => setBase({ angle }, 'angle')}
              onCommit={endGesture}
            />
          )}
          <Slider
            label={t('atelier.props.softness')}
            value={base.softness ?? 0}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(softness) => setBase({ softness }, 'softness')}
            onCommit={endGesture}
          />
          <Field label={t('atelier.props.pattern')}>
            {() => (
              <div className="flex items-center gap-3">
                <Button size={28} onClick={() => setBase({ seed: shuffledSeed(base.seed) })}>
                  <Shuffle size={14} strokeWidth={1.75} aria-hidden />
                  {t('atelier.props.shuffle')}
                </Button>
                <span className="font-mono text-mono-sm text-ink-4">#{base.seed}</span>
              </div>
            )}
          </Field>
        </>
      )}

      <Slider
        label={t('atelier.props.wear')}
        value={base.wear ?? 0}
        min={0}
        max={1}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        hint={t('atelier.props.wearHintBase')}
        onChange={(wear) => setBase({ wear }, 'wear')}
        onCommit={endGesture}
      />
    </>
  );
}

// ── Protected areas ─────────────────────────────────────────────────────────

function MaskProperties({ brush, onBrush, hidden, strokes }: { brush: BrushUi; onBrush: (patch: Partial<BrushUi>) => void; hidden: boolean; strokes: number }) {
  const { t } = useTranslation();
  const clearMask = useAtelierEditor((s) => s.clearMask);
  const toggleVisible = useAtelierEditor((s) => s.toggleLayerVisible);
  const maskId = useAtelierEditor((s) => maskOf(s.layers)?.id);
  const parts: { value: PartGroup; label: string }[] = [
    { value: 'hull', label: t('atelier.props.hull') },
    { value: 'turret', label: t('atelier.props.turret') },
    { value: 'gun', label: t('atelier.props.gun') },
  ];

  return (
    <>
      <p className="text-meta text-ink-3">{t('atelier.props.maskHelp')}</p>
      {hidden && (
        <div className="flex flex-col items-start gap-2 rounded-ctl border border-line-2 bg-bg-2 p-3">
          <p className="text-meta text-ink-2">{t('atelier.props.maskHidden')}</p>
          <Button size={26} onClick={() => maskId && toggleVisible(maskId)}>
            {t('atelier.props.showMask')}
          </Button>
        </div>
      )}
      <Field label={t('atelier.props.tool')}>
        {(id) => (
          <SegmentedControl
            label={t('atelier.props.tool')}
            aria-describedby={id}
            value={brush.erase ? 'erase' : 'protect'}
            options={[
              { value: 'protect', label: t('atelier.props.protect') },
              { value: 'erase', label: t('atelier.props.erase') },
            ]}
            onChange={(v) => onBrush({ erase: v === 'erase' })}
            className="self-start"
          />
        )}
      </Field>
      <Slider
        label={t('atelier.props.size')}
        value={brush.size}
        min={BRUSH_MIN}
        max={BRUSH_MAX}
        step={0.005}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(size) => onBrush({ size })}
      />
      <Slider
        label={t('atelier.props.hardness')}
        value={brush.hardness}
        min={0}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(hardness) => onBrush({ hardness })}
      />
      <ChipDropdown<PartGroup>
        label={t('atelier.props.only')}
        value={brush.part === 'all' ? null : brush.part}
        options={parts}
        anyLabel={t('atelier.props.allParts')}
        onChange={(v) => onBrush({ part: v ?? 'all' })}
        className="self-start"
      />
      <div className="flex-1" />
      <Button size={30} variant="danger" disabled={strokes === 0} onClick={clearMask} className="self-start">
        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        {t('atelier.props.clear')}
      </Button>
    </>
  );
}

