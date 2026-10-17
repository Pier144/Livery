import { Circle, Hexagon, Square, Star, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import {
  DEFAULT_INNER_RATIO,
  DEFAULT_POLYGON_SIDES,
  DEFAULT_SHAPE_STRIPE_ANGLE,
  DEFAULT_STAR_POINTS,
  DEFAULT_STRIPE_WIDTH,
  HAZARD_DARK,
  MAX_CORNER,
  MAX_DECAL_SIZE,
  MAX_INNER_RATIO,
  MAX_OUTLINE_WIDTH,
  MAX_SHAPE_POINTS,
  MIN_DECAL_SIZE,
  MIN_INNER_RATIO,
  MIN_SHAPE_POINTS,
  SHAPE_KINDS,
  SHAPE_STRIPE_ANGLE_MAX,
  SHAPE_STRIPE_ANGLE_MIN,
  STRIPE_WIDTH_MAX,
  STRIPE_WIDTH_MIN,
  type Decal,
  type ShapeFill,
  type ShapeKind,
  type ShapeLayer,
} from '@/atelier/project';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/cn';
import { ColorSwatch, Field, Slider } from './controls';
import { NotPlaced, PlacementRows } from './DecalProperties';
import { RepeatSection } from './RepeatSection';

/** A shape layer or a shape piece (what the content rows edit: no frame, no repeat). */
type ShapeLike = Omit<ShapeLayer, 'decal' | 'repeat'>;

const SHAPE_ICONS: Record<ShapeKind, LucideIcon> = { rect: Square, ellipse: Circle, star: Star, polygon: Hexagon };

/** Centimetres the Size fields take (MIN_DECAL_SIZE to MAX_DECAL_SIZE metres). */
const MIN_SIZE_CM = MIN_DECAL_SIZE * 100;
const MAX_SIZE_CM = MAX_DECAL_SIZE * 100;

/** Metres as the Size fields show them: centimetres, at most one decimal. */
const cmText = (m: number) => String(Math.round(m * 1000) / 10);

/**
 * A shape layer's settings: its content (`ShapeContent`), its Size in centimetres, then the rows
 * every placed layer shares and its Repeat.
 */
export function ShapeProperties({
  layer,
  checkShared,
  mirrorAxis,
}: {
  layer: ShapeLayer;
  checkShared: (layerId: string, decal?: Decal) => Promise<boolean>;
  mirrorAxis: number;
}) {
  if (!layer.decal) return <NotPlaced id={layer.id} />;
  return (
    <>
      <ShapeContent layer={layer} />
      <SizeFields id={layer.id} decal={layer.decal} />
      <PlacementRows layer={layer} decal={layer.decal} checkShared={checkShared} />
      <RepeatSection layer={layer} mirrorAxis={mirrorAxis} />
    </>
  );
}

/**
 * What a shape looks like (layer or piece): the shape picker, its options (Corner rounding; Points
 * and Inner size; Sides), Fill (Solid: one colour; Stripes: two colours, angle and stripe width)
 * and Outline. Sliders and colour pickers make one undo step per drag or picker session.
 */
export function ShapeContent({ layer }: { layer: ShapeLike }) {
  const { t } = useTranslation();
  const setLayerProps = useAtelierEditor((s) => s.setLayerProps);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  const { fill } = layer;
  const set = (patch: Partial<ShapeLike>, mergeKey?: string) => setLayerProps(layer.id, patch, mergeKey);
  const setFill = (next: ShapeFill, mergeKey?: string) => set({ fill: next }, mergeKey);

  const setFillKind = (kind: ShapeFill['kind']) => {
    if (kind === fill.kind) return;
    // Solid → Stripes keeps the colour as the first stripe colour; Stripes → Solid keeps the first.
    if (kind === 'stripes' && fill.kind === 'solid') {
      setFill({ kind: 'stripes', colors: [fill.color, HAZARD_DARK], angle: DEFAULT_SHAPE_STRIPE_ANGLE, stripeWidth: DEFAULT_STRIPE_WIDTH });
    } else if (kind === 'solid' && fill.kind === 'stripes') {
      setFill({ kind: 'solid', color: fill.colors[0] });
    }
  };

  return (
    <>
      <Field label={t('atelier.layers.shape')}>
        {(id) => (
          <div role="group" aria-labelledby={id} className="flex gap-1.5">
            {SHAPE_KINDS.map((shape) => {
              const Icon = SHAPE_ICONS[shape];
              const pressed = layer.shape === shape;
              return (
                <button
                  key={shape}
                  type="button"
                  aria-pressed={pressed}
                  aria-label={t(`atelier.shape.${shape}`)}
                  title={t(`atelier.shape.${shape}`)}
                  onClick={() => !pressed && set({ shape })}
                  className={cn(
                    'grid h-8 w-8 place-items-center rounded-ctl border motion-safe:transition-colors motion-safe:duration-120',
                    pressed ? 'border-amber bg-bg-4 text-ink-1' : 'border-line-3 text-ink-3 hover:border-line-4 hover:text-ink-1',
                  )}
                >
                  <Icon size={14} strokeWidth={1.75} aria-hidden />
                </button>
              );
            })}
          </div>
        )}
      </Field>

      {layer.shape === 'rect' && (
        <Slider
          label={t('atelier.props.corner')}
          value={layer.corner ?? 0}
          min={0}
          max={MAX_CORNER}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(corner) => set({ corner }, 'corner')}
          onCommit={endGesture}
        />
      )}
      {layer.shape === 'star' && (
        <>
          <Slider
            label={t('atelier.props.points')}
            value={layer.points ?? DEFAULT_STAR_POINTS}
            min={MIN_SHAPE_POINTS}
            max={MAX_SHAPE_POINTS}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(points) => set({ points: Math.round(points) }, 'points')}
            onCommit={endGesture}
          />
          <Slider
            label={t('atelier.props.innerSize')}
            value={layer.innerRatio ?? DEFAULT_INNER_RATIO}
            min={MIN_INNER_RATIO}
            max={MAX_INNER_RATIO}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(innerRatio) => set({ innerRatio }, 'innerRatio')}
            onCommit={endGesture}
          />
        </>
      )}
      {layer.shape === 'polygon' && (
        <Slider
          label={t('atelier.props.sides')}
          value={layer.points ?? DEFAULT_POLYGON_SIDES}
          min={MIN_SHAPE_POINTS}
          max={MAX_SHAPE_POINTS}
          step={1}
          format={(v) => String(Math.round(v))}
          onChange={(points) => set({ points: Math.round(points) }, 'points')}
          onCommit={endGesture}
        />
      )}

      <Field label={t('atelier.props.fill')}>
        {(id) => (
          <div className="flex flex-col gap-2">
            <SegmentedControl
              label={t('atelier.props.fill')}
              aria-describedby={id}
              value={fill.kind}
              options={[
                { value: 'solid', label: t('atelier.props.solid') },
                { value: 'stripes', label: t('atelier.props.stripes') },
              ]}
              onChange={setFillKind}
              className="self-start"
            />
            <div className="flex items-center gap-2">
              {fill.kind === 'solid' ? (
                <ColorSwatch value={fill.color} label={t('atelier.props.fillColor')} onInput={(hex) => setFill({ ...fill, color: hex.toLowerCase() }, 'fill-color')} onCommit={endGesture} />
              ) : (
                fill.colors.map((color, i) => (
                  <ColorSwatch
                    key={i}
                    value={color}
                    label={t('atelier.props.colorN', { n: i + 1 })}
                    onInput={(hex) => {
                      const colors: [string, string] = [...fill.colors];
                      colors[i] = hex.toLowerCase();
                      setFill({ ...fill, colors }, `fill-color-${i}`);
                    }}
                    onCommit={endGesture}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </Field>
      {fill.kind === 'stripes' && (
        <>
          <Slider
            label={t('atelier.props.angle')}
            value={fill.angle}
            min={SHAPE_STRIPE_ANGLE_MIN}
            max={SHAPE_STRIPE_ANGLE_MAX}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(angle) => setFill({ ...fill, angle }, 'fill-angle')}
            onCommit={endGesture}
          />
          <Slider
            label={t('atelier.props.stripeWidth')}
            value={fill.stripeWidth}
            min={STRIPE_WIDTH_MIN}
            max={STRIPE_WIDTH_MAX}
            step={0.01}
            format={(v) => t('atelier.props.cm', { value: Math.round(v * 100) })}
            onChange={(stripeWidth) => setFill({ ...fill, stripeWidth }, 'fill-stripe-width')}
            onCommit={endGesture}
          />
        </>
      )}

      <Field label={t('atelier.props.outline')}>
        {() => (
          <ColorSwatch
            value={layer.outlineColor}
            label={t('atelier.props.outlineColor')}
            onInput={(outlineColor) => set({ outlineColor: outlineColor.toLowerCase() }, 'outlineColor')}
            onCommit={endGesture}
          />
        )}
      </Field>
      <Slider
        label={t('atelier.props.outlineWidth')}
        value={layer.outlineWidth}
        min={0}
        max={MAX_OUTLINE_WIDTH}
        step={0.5}
        format={(v) => `${v.toFixed(1)}%`}
        onChange={(outlineWidth) => set({ outlineWidth }, 'outlineWidth')}
        onCommit={endGesture}
      />
    </>
  );
}

/** Width and height in centimetres, applied on Enter or when the field is left (one undo step each). */
function SizeFields({ id, decal }: { id: string; decal: Decal }) {
  const { t } = useTranslation();
  return (
    <Field label={t('atelier.props.shapeSize')}>
      {(labelId) => (
        <div role="group" aria-labelledby={labelId} className="grid grid-cols-2 gap-2">
          <SizeField layerId={id} axis="width" value={decal.width} label={t('atelier.props.width')} />
          <SizeField layerId={id} axis="height" value={decal.height} label={t('atelier.props.height')} />
        </div>
      )}
    </Field>
  );
}

/**
 * One size in centimetres. Typing doesn't touch the layer; Enter or leaving the field applies it
 * (clamped to what a frame may measure, a comma read as the decimal point); text that isn't a
 * positive number, or Escape, puts the current size back.
 */
function SizeField({ layerId, axis, value, label }: { layerId: string; axis: 'width' | 'height'; value: number; label: string }) {
  const { t } = useTranslation();
  const setDecal = useAtelierEditor((s) => s.setDecal);
  const inputId = useId();
  const unitId = useId();
  const [draft, setDraft] = useState(() => cmText(value));
  const editing = useRef(false);
  // Undo, redo, the gizmo or another layer: the field shows the frame's size (not while typing in it).
  useEffect(() => {
    if (!editing.current) setDraft(cmText(value));
  }, [value, layerId]);

  const apply = () => {
    // Left as shown: the rounded centimetres must not overwrite the exact size.
    if (draft.trim() === cmText(value)) return;
    const cm = Number(draft.trim().replace(',', '.'));
    if (!Number.isFinite(cm) || cm <= 0) {
      setDraft(cmText(value));
      return;
    }
    const metres = Math.min(MAX_SIZE_CM, Math.max(MIN_SIZE_CM, cm)) / 100;
    setDraft(cmText(metres));
    if (metres !== value) setDecal(layerId, { [axis]: metres });
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={inputId} className="text-meta text-ink-4">
        {label}
      </label>
      <div className="flex h-ctl min-w-0 items-center gap-1.5 rounded-ctl border border-line-3 bg-bg-input pr-2 hover:border-line-4 focus-within:border-line-4">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          value={draft}
          aria-describedby={unitId}
          onFocus={() => {
            editing.current = true;
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
              // Applied: the field follows the frame again (undo, the gizmo) while it keeps focus.
              editing.current = false;
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(cmText(value));
            }
          }}
          onBlur={() => {
            editing.current = false;
            apply();
          }}
          className="h-full w-full min-w-0 bg-transparent px-2 font-mono text-mono-sm text-ink-1 outline-none"
        />
        <span id={unitId} className="flex-none text-meta text-ink-4">
          {t('atelier.props.unitCm')}
        </span>
      </div>
    </div>
  );
}
