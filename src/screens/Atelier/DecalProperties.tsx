import { Brush, Crosshair, FlipHorizontal2, Wand2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import {
  MAX_OUTLINE_WIDTH,
  MAX_SKEW,
  MAX_TEXT_CHARS,
  type Decal,
  type DecalLayer,
  type FontRef,
  type ImageLayer,
  type PartFilter,
  type PlacedLayer,
  type TextLayer,
} from '@/atelier/project';
import { debounce, fontStatus } from '@/atelier/text';
import { Button } from '@/components/ui/Button';
import { ChipDropdown } from '@/components/ui/ChipDropdown';
import { Switch } from '@/components/ui/Switch';
import { useFonts } from '@/queries/atelier';
import type { PartGroup } from '@/types';
import { ColorSwatch, Field, Slider } from './controls';
import { MAX_DEPTH_UI, MIN_DEPTH_UI } from './decalOps';
import { setPlacingLayer, useDecalUi } from './decalUi';
import { RepeatSection } from './RepeatSection';

interface DecalPropertiesProps {
  layer: DecalLayer;
  checkShared: (layerId: string, decal?: Decal) => Promise<boolean>;
  onRemoveBackground: (layerId: string) => void;
  onRefineEdge: (layerId: string) => void;
  /** The model's mirror plane (`ModelHeader.mirrorAxis`), for the Repeat copies budget. */
  mirrorAxis: number;
}

/** At most MAX_TEXT_CHARS characters (code points), as the project stores text. */
export function clampText(text: string): string {
  const chars = [...text];
  return chars.length > MAX_TEXT_CHARS ? chars.slice(0, MAX_TEXT_CHARS).join('') : text;
}

const SELECT =
  'h-ctl w-full min-w-0 rounded-ctl border border-line-3 bg-bg-input px-2 text-meta text-ink-1 hover:border-line-4 focus-visible:outline focus-visible:-outline-offset-1 disabled:opacity-50';

/** A text layer or a text piece (what the content rows edit: no frame, no repeat). */
type TextLike = Omit<TextLayer, 'decal' | 'repeat'>;

/**
 * An image or text layer's settings: what it shows (text, font, colours, outline, slant; for a
 * picture flip, Remove background and Refine edge), how it is drawn (opacity, wear, box depth),
 * where (Only this part, Mirror) and its Repeat. Sliders and colour pickers make one undo step per
 * drag or picker session; text typed in the field reaches the layer 150 ms after the last key (one
 * undo step until the field is left).
 */
export function DecalProperties({ layer, checkShared, onRemoveBackground, onRefineEdge, mirrorAxis }: DecalPropertiesProps) {
  const missing = useDecalUi((s) => layer.kind === 'image' && s.missingAssets[layer.assetId] === true);
  useDecalUi((s) => s.fontsVersion);

  if (!layer.decal) return <NotPlaced id={layer.id} />;
  return (
    <>
      {layer.kind === 'image' ? (
        <ImageContent layer={layer} missing={missing} onRemoveBackground={onRemoveBackground} onRefineEdge={onRefineEdge} />
      ) : (
        <TextContent layer={layer} />
      )}
      <PlacementRows layer={layer} decal={layer.decal} checkShared={checkShared} />
      <RepeatSection layer={layer} mirrorAxis={mirrorAxis} />
    </>
  );
}

/** A placed layer whose saved placement didn't check out: offers to place it again. */
export function NotPlaced({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 rounded-ctl border border-line-2 bg-bg-2 p-3">
      <p className="text-meta text-ink-2">{t('atelier.props.notPlaced')}</p>
      <Button size={28} onClick={() => setPlacingLayer(id)}>
        <Crosshair size={14} strokeWidth={1.75} aria-hidden />
        {t('atelier.props.placeAgain')}
      </Button>
    </div>
  );
}

/** Opacity of a placed layer or a piece (one undo step per drag). */
export function OpacityRow({ id, opacity }: { id: string; opacity: number }) {
  const { t } = useTranslation();
  const setLayerProps = useAtelierEditor((s) => s.setLayerProps);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  return (
    <Slider
      label={t('atelier.props.opacity')}
      value={opacity}
      min={0}
      max={1}
      step={0.01}
      format={(v) => `${Math.round(v * 100)}%`}
      onChange={(next) => setLayerProps(id, { opacity: next }, 'opacity')}
      onCommit={endGesture}
    />
  );
}

/** Wear of an image, text or shape layer or piece (merged objects have none of their own). */
export function WearRow({ id, wear }: { id: string; wear: number | undefined }) {
  const { t } = useTranslation();
  const setLayerProps = useAtelierEditor((s) => s.setLayerProps);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  return (
    <Slider
      label={t('atelier.props.wear')}
      value={wear ?? 0}
      min={0}
      max={1}
      step={0.01}
      format={(v) => `${Math.round(v * 100)}%`}
      hint={t('atelier.props.wearHintDecal')}
      onChange={(next) => setLayerProps(id, { wear: next }, 'wear')}
      onCommit={endGesture}
    />
  );
}

/**
 * The rows every placed layer shares: Opacity, Wear (not on merged objects: they have none),
 * Depth, Only this part and Mirror.
 */
export function PlacementRows({ layer, decal, checkShared }: { layer: PlacedLayer; decal: Decal; checkShared: DecalPropertiesProps['checkShared'] }) {
  const { t } = useTranslation();
  const setDecal = useAtelierEditor((s) => s.setDecal);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  return (
    <>
      <OpacityRow id={layer.id} opacity={layer.opacity} />
      {layer.kind !== 'merged' && <WearRow id={layer.id} wear={layer.wear} />}
      <Slider
        label={t('atelier.props.depth')}
        value={Math.min(MAX_DEPTH_UI, Math.max(MIN_DEPTH_UI, decal.depth))}
        min={MIN_DEPTH_UI}
        max={MAX_DEPTH_UI}
        step={0.01}
        format={(v) => t('atelier.props.cm', { value: Math.round(v * 100) })}
        hint={t('atelier.props.depthHint')}
        onChange={(depth) => setDecal(layer.id, { depth }, 'depth')}
        onCommit={endGesture}
      />
      <PartFilterChip value={decal.part} onChange={(part) => setDecal(layer.id, { part })} />
      <MirrorRow id={layer.id} decal={decal} checkShared={checkShared} />
    </>
  );
}

function PartFilterChip({ value, onChange }: { value: string; onChange: (part: PartFilter) => void }) {
  const { t } = useTranslation();
  const parts: { value: PartGroup; label: string }[] = [
    { value: 'hull', label: t('atelier.props.hull') },
    { value: 'turret', label: t('atelier.props.turret') },
    { value: 'gun', label: t('atelier.props.gun') },
  ];
  const current = parts.find((p) => p.value === value)?.value ?? null;
  return (
    <ChipDropdown<PartGroup>
      label={t('atelier.props.only')}
      value={current}
      options={parts}
      anyLabel={t('atelier.props.allParts')}
      onChange={(v) => onChange(v ?? 'all')}
      className="self-start"
    />
  );
}

/** Mirror to the other side: off by default; offered off where the model already shares the texture between sides. */
function MirrorRow({ id: layerId, decal, checkShared }: { id: string; decal: Decal; checkShared: DecalPropertiesProps['checkShared'] }) {
  const { t } = useTranslation();
  const labelId = useId();
  const hintId = useId();
  const shared = useDecalUi((s) => s.shared[layerId] === true);
  // Which layer a check runs for: the panel may show another layer by the time it answers.
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const checking = checkingId === layerId;
  const setDecal = useAtelierEditor((s) => s.setDecal);

  const toggle = async (next: boolean) => {
    const id = layerId;
    if (!next) {
      setDecal(id, { mirror: false });
      return;
    }
    setCheckingId(id);
    try {
      if (!(await checkShared(id, decal))) setDecal(id, { mirror: true });
    } finally {
      setCheckingId((c) => (c === id ? null : c));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="text-meta text-ink-3">
          {t('atelier.props.mirror')}
        </span>
        <Switch
          checked={decal.mirror}
          onChange={(next) => void toggle(next)}
          disabled={checking || (shared && !decal.mirror)}
          aria-busy={checking || undefined}
          aria-labelledby={labelId}
          aria-describedby={hintId}
        />
      </div>
      <p id={hintId} className="text-meta text-ink-4">
        {shared ? t('atelier.props.mirrorShared') : t('atelier.props.mirrorHelp')}
      </p>
    </div>
  );
}

/**
 * A picture's content rows: flip, and for a layer (not a piece: a piece's picture changes only
 * once its object is separated) Remove background and Refine edge.
 */
export function ImageContent({
  layer,
  missing,
  onRemoveBackground,
  onRefineEdge,
}: {
  layer: Pick<ImageLayer, 'id' | 'flipX'>;
  missing: boolean;
  /** Left out for a piece, with `onRefineEdge`: no Remove background or Refine edge. */
  onRemoveBackground?: (id: string) => void;
  onRefineEdge?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const setLayerProps = useAtelierEditor((s) => s.setLayerProps);
  const busy = useDecalUi((s) => s.cutoutBusy);
  const flipId = useId();
  return (
    <>
      {missing && <p className="rounded-ctl border border-line-2 bg-bg-2 p-3 text-meta text-ink-2">{t('atelier.props.missingPicture')}</p>}
      <div className="flex items-center justify-between gap-3">
        <span id={flipId} className="flex items-center gap-2 text-meta text-ink-3">
          <FlipHorizontal2 size={14} strokeWidth={1.75} aria-hidden />
          {t('atelier.props.flip')}
        </span>
        <Switch checked={layer.flipX} onChange={(flipX) => setLayerProps(layer.id, { flipX })} aria-labelledby={flipId} />
      </div>
      {onRemoveBackground && onRefineEdge && (
        <div className="flex flex-wrap gap-2">
          <Button size={28} disabled={missing || busy} onClick={() => onRemoveBackground(layer.id)} title={t('atelier.props.removeBackgroundHint')}>
            <Wand2 size={14} strokeWidth={1.75} aria-hidden />
            {t('atelier.props.removeBackground')}
          </Button>
          <Button size={28} disabled={missing} onClick={() => onRefineEdge(layer.id)} title={t('atelier.props.refineEdgeHint')}>
            <Brush size={14} strokeWidth={1.75} aria-hidden />
            {t('atelier.props.refineEdge')}
          </Button>
        </div>
      )}
    </>
  );
}

/** A text layer's or text piece's content rows: text, font, colours, outline and slant. */
export function TextContent({ layer }: { layer: TextLike }) {
  const { t } = useTranslation();
  const setLayerProps = useAtelierEditor((s) => s.setLayerProps);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  const fonts = useFonts();
  const textId = useId();
  const familyId = useId();
  const styleId = useId();
  const countId = useId();
  const [draft, setDraft] = useState(layer.text);
  const editing = useRef(false);

  // Typing re-rasterises the text: the layer gets it 150 ms after the last key.
  const id = layer.id;
  const push = useMemo(() => debounce((text: string) => useAtelierEditor.getState().setLayerProps(id, { text }, 'text')), [id]);
  useEffect(() => () => push.flush(), [push]);
  // Undo, redo or another layer: the field shows the layer's text (not while typing in it).
  useEffect(() => {
    if (!editing.current) setDraft(layer.text);
  }, [layer.text, id]);

  const families = useMemo(() => {
    const list = [...new Set((fonts.data ?? []).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    if (!list.includes(layer.font.family)) list.unshift(layer.font.family);
    return list;
  }, [fonts.data, layer.font.family]);
  const styles = useMemo(() => {
    const list = (fonts.data ?? []).filter((f) => f.family === layer.font.family).map((f) => f.style);
    if (!list.includes(layer.font.style)) list.unshift(layer.font.style);
    return list;
  }, [fonts.data, layer.font.family, layer.font.style]);

  const setFont = (font: FontRef) => setLayerProps(layer.id, { font });
  const pickFamily = (family: string) => {
    const available = (fonts.data ?? []).filter((f) => f.family === family).map((f) => f.style);
    const style = available.includes(layer.font.style) ? layer.font.style : (available.find((s) => s === 'Regular') ?? available[0] ?? 'Regular');
    setFont({ family, style });
  };
  const fontMissing = fontStatus(layer.font) === 'missing';

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={textId} className="text-meta text-ink-3">
            {t('atelier.props.text')}
          </label>
          <span id={countId} className="font-mono text-mono-sm text-ink-4">
            {t('atelier.props.textCount', { n: [...draft].length, max: MAX_TEXT_CHARS })}
          </span>
        </div>
        <textarea
          id={textId}
          value={draft}
          rows={2}
          aria-describedby={countId}
          onFocus={() => {
            editing.current = true;
          }}
          onKeyDown={(e) => {
            // One line of text: Enter doesn't add a line break (it still confirms an IME composition).
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault();
          }}
          onChange={(e) => {
            // Counted and cut like the layer stores it (characters, not UTF-16 units); pasted line breaks become spaces.
            const text = clampText(e.target.value.replace(/\r?\n/g, ' '));
            setDraft(text);
            push(text);
          }}
          onBlur={() => {
            editing.current = false;
            push.flush();
            endGesture();
          }}
          className="min-h-[52px] w-full resize-y rounded-ctl border border-line-3 bg-bg-input px-2 py-1.5 text-body text-ink-1 outline-none hover:border-line-4 focus-visible:border-line-4"
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={familyId} className="text-meta text-ink-3">
            {t('atelier.props.font')}
          </label>
          <select id={familyId} value={layer.font.family} onChange={(e) => pickFamily(e.target.value)} className={SELECT}>
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={styleId} className="text-meta text-ink-3">
            {t('atelier.props.fontStyle')}
          </label>
          <select id={styleId} value={layer.font.style} onChange={(e) => setFont({ family: layer.font.family, style: e.target.value })} className={SELECT}>
            {styles.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      {fontMissing && <p className="text-meta text-ink-3">{t('atelier.props.fontMissing')}</p>}
      <Field label={t('atelier.props.colors')}>
        {() => (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <ColorSwatch value={layer.color} label={t('atelier.props.textColor')} onInput={(color) => setLayerProps(layer.id, { color }, 'color')} onCommit={endGesture} />
              <span className="text-meta text-ink-3">{t('atelier.props.fill')}</span>
            </div>
            <div className="flex items-center gap-2">
              <ColorSwatch
                value={layer.outlineColor}
                label={t('atelier.props.outlineColor')}
                onInput={(outlineColor) => setLayerProps(layer.id, { outlineColor }, 'outlineColor')}
                onCommit={endGesture}
              />
              <span className="text-meta text-ink-3">{t('atelier.props.outline')}</span>
            </div>
          </div>
        )}
      </Field>
      <Slider
        label={t('atelier.props.outlineWidth')}
        value={layer.outlineWidth}
        min={0}
        max={MAX_OUTLINE_WIDTH}
        step={0.5}
        format={(v) => `${v.toFixed(1)}%`}
        onChange={(outlineWidth) => setLayerProps(layer.id, { outlineWidth }, 'outlineWidth')}
        onCommit={endGesture}
      />
      <Slider
        label={t('atelier.props.skew')}
        value={layer.skew}
        min={-MAX_SKEW}
        max={MAX_SKEW}
        step={0.01}
        format={(v) => `${Math.round((Math.atan(v) * 180) / Math.PI)}°`}
        onChange={(skew) => setLayerProps(layer.id, { skew }, 'skew')}
        onCommit={endGesture}
      />
    </>
  );
}
