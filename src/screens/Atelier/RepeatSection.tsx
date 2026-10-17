import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { drawGroups } from '@/atelier/drawItems';
import { useAtelierEditor } from '@/atelier/editorStore';
import { DEFAULT_REPEAT_GAP, HAZARD_DARK, MAX_DRAW_ITEMS, MAX_REPEAT, MAX_REPEAT_GAP, type Layer, type PlacedLayer, type Repeat } from '@/atelier/project';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { ColorSwatch, Field, Slider } from './controls';

/** Copies a new repeat starts with. */
const START_COUNT = 3;

/** Boxes one copy of `layer` draws: its pieces (merged objects), twice with Mirror on. */
function boxesPerCopy(layer: PlacedLayer): number {
  const pieces = layer.kind === 'merged' ? layer.children.filter((c) => c.kind !== 'unsupported' && c.visible && c.opacity > 0).length : 1;
  return Math.max(1, pieces) * (layer.decal?.mirror ? 2 : 1);
}

/**
 * The most copies `layer` may have without passing the project's draw budget (MAX_DRAW_ITEMS
 * boxes, mirror copies counted): what the other layers leave, over the boxes one copy draws; at
 * most MAX_REPEAT, at least 2. For a drawn layer this is its count plus what is still free.
 */
export function repeatCap(layers: readonly Layer[], layer: PlacedLayer, mirrorAxis: number): number {
  // No budget: layers past it are counted too (they are what the budget leaves out).
  const plan = drawGroups(layers, mirrorAxis, Infinity);
  // The layer's own groups: `id`, `id:alt` (alternate colour), `id/pieceId` (merged pieces).
  const own = plan.groups
    .filter((g) => g.id === layer.id || g.id.startsWith(`${layer.id}:`) || g.id.startsWith(`${layer.id}/`))
    .reduce((n, g) => n + g.boxes.length, 0);
  const free = MAX_DRAW_ITEMS - (plan.boxes - own);
  return Math.min(MAX_REPEAT, Math.max(2, Math.floor(free / boxesPerCopy(layer))));
}

/**
 * Copies of a placed layer in a row or column: a "Repeat" switch, and when on Copies (up to what
 * the draw budget leaves), Spacing, Direction and, for a solid shape, an alternate colour for every
 * second copy. Sliders and the colour picker make one undo step per drag or picker session.
 */
export function RepeatSection({ layer, mirrorAxis }: { layer: PlacedLayer; mirrorAxis: number }) {
  const { t } = useTranslation();
  const layers = useAtelierEditor((s) => s.layers);
  const setLayerProps = useAtelierEditor((s) => s.setLayerProps);
  const endGesture = useAtelierEditor((s) => s.endGesture);
  const switchId = useId();
  const alternateId = useId();
  const repeat = layer.repeat;
  const cap = repeatCap(layers, layer, mirrorAxis);

  const setRepeat = (next: Repeat | null, mergeKey?: string) => setLayerProps(layer.id, { repeat: next }, mergeKey);
  const toggle = (on: boolean) => setRepeat(on ? { count: Math.min(START_COUNT, cap), gap: DEFAULT_REPEAT_GAP, direction: 'row' } : null);
  const solidShape = layer.kind === 'shape' && layer.fill.kind === 'solid';

  return (
    <div className="flex flex-col gap-4.5">
      <div className="flex items-center justify-between gap-3">
        <span id={switchId} className="text-meta text-ink-3">
          {t('atelier.props.repeat')}
        </span>
        <Switch checked={repeat !== undefined} onChange={toggle} aria-labelledby={switchId} />
      </div>
      {repeat && (
        <>
          <Slider
            label={t('atelier.props.copies')}
            value={repeat.count}
            min={2}
            max={Math.max(cap, repeat.count)}
            step={1}
            format={(v) => String(Math.round(v))}
            hint={repeat.count >= cap && cap < MAX_REPEAT ? t('atelier.props.copiesLimit') : undefined}
            onChange={(count) => setRepeat({ ...repeat, count: Math.round(count) }, 'repeat-count')}
            onCommit={endGesture}
          />
          <Slider
            label={t('atelier.props.spacing')}
            value={repeat.gap}
            min={0}
            max={MAX_REPEAT_GAP}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(gap) => setRepeat({ ...repeat, gap }, 'repeat-gap')}
            onCommit={endGesture}
          />
          <Field label={t('atelier.props.direction')}>
            {(id) => (
              <SegmentedControl
                label={t('atelier.props.direction')}
                aria-describedby={id}
                value={repeat.direction}
                options={[
                  { value: 'row', label: t('atelier.props.row') },
                  { value: 'column', label: t('atelier.props.column') },
                ]}
                onChange={(direction) => setRepeat({ ...repeat, direction })}
                className="self-start"
              />
            )}
          </Field>
          {solidShape && (
            <div className="flex items-center justify-between gap-3">
              <span id={alternateId} className="text-meta text-ink-3">
                {t('atelier.props.alternate')}
              </span>
              <div className="flex items-center gap-3">
                {repeat.alternate !== undefined && (
                  <ColorSwatch
                    value={repeat.alternate}
                    label={t('atelier.props.alternateColor')}
                    onInput={(hex) => setRepeat({ ...repeat, alternate: hex.toLowerCase() }, 'repeat-alternate')}
                    onCommit={endGesture}
                  />
                )}
                <Switch
                  checked={repeat.alternate !== undefined}
                  onChange={(on) => {
                    const { alternate: _alternate, ...rest } = repeat;
                    setRepeat(on ? { ...rest, alternate: HAZARD_DARK } : rest);
                  }}
                  aria-labelledby={alternateId}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
