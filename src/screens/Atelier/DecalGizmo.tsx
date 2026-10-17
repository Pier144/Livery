import { useEffect, useReducer, useRef, useState, type PointerEvent } from 'react';
import { useAtelierEditor } from '@/atelier/editorStore';
import { framedLayers } from '@/atelier/layerTree';
import { envelopeOf } from '@/atelier/merge';
import { decalRight, dot, partGroupOf, type Decal, type PlacedLayer, type Vec3 } from '@/atelier/project';
import { axisScale, decalCorners, framedLayerOf, rotateDecal, scaleDecal, slideOnto } from './decalOps';
import { snapLevel, snapMove, unitsPerPixel, type SnapGuide } from './decalSnap';
import { useDecalUi } from './decalUi';
import type { EngineScene } from './engine';

/** Distance of the rotate handle from the top edge, CSS px. */
const ROTATE_OFFSET = 26;
/** Shift snaps a rotation to this many degrees. */
const ROTATE_SNAP_DEG = 15;

type Point = { x: number; y: number };

type Gesture =
  | { kind: 'move'; offset: Point }
  | { kind: 'scale'; centre: Point; start: Point; decal: Decal }
  /** An edge handle: stretches one axis (`x` across, `y` up). */
  | { kind: 'edge'; axis: 'x' | 'y'; centre: Point; start: Point; decal: Decal }
  | { kind: 'rotate'; centre: Point; start: number; decal: Decal; sign: number };

interface DecalGizmoProps {
  scene: EngineScene;
  layer: PlacedLayer & { decal: Decal };
  /** The model's mirror plane (`ModelHeader.mirrorAxis`), the centre line moves snap to. */
  mirrorAxis: number;
  /** A drag on a handle begins (the view takes focus, so the keys work next). */
  onGestureStart: () => void;
  /** A drag ended: one undo step was made; the caller re-checks shared texels. */
  onGestureEnd: (layerId: string) => void;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Point) => Math.hypot(a.x, a.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The selected decal's current state (the store's, not the props', during a drag). */
function liveDecal(id: string): Decal | null {
  return framedLayerOf(useAtelierEditor.getState().layers, id)?.decal ?? null;
}

/** The other placed frames (top level and in folders, merged objects included; never pieces), which a moved decal aligns with. */
function otherDecals(id: string): Decal[] {
  return framedLayers(useAtelierEditor.getState().layers).flatMap((l) => (l.id !== id && l.decal ? [l.decal] : []));
}

/** `decal`'s axes on screen from `centre`: half its width along its right, half its height along its up. */
function screenAxes(scene: EngineScene, decal: Decal, centre: Point): { right: Point; up: Point } {
  return {
    right: sub(scene.project(add3(decal.center, decalRight(decal), decal.width / 2)), centre),
    up: sub(scene.project(add3(decal.center, decal.up, decal.height / 2)), centre),
  };
}

/** The corners of `decal` on screen, or null when one is behind the camera or off the numbers. */
function screenCorners(scene: EngineScene, decal: Decal): Point[] | null {
  const corners = decalCorners(decal).map((c) => scene.project(c));
  return corners.some((c) => c.behind || !Number.isFinite(c.x) || !Number.isFinite(c.y)) ? null : corners;
}

const pointsOf = (corners: readonly Point[]) => corners.map((c) => `${c.x},${c.y}`).join(' ');

/**
 * The selected placed layer's frame on the 3D view: its box outlined on screen (the four corners on
 * its plane, projected), with a body that slides it along the surface (re-raycast under the
 * pointer, normal and up re-derived), corner handles that scale it keeping its ratio (Shift frees
 * it for images and shapes; text keeps its measured aspect, and merged objects always scale
 * uniformly so their rotated pieces never skew), edge handles on shapes that stretch one axis, and
 * a rotate handle that turns it around its normal (Shift snaps to 15°). With Repeat on, the whole
 * row or column is outlined dashed around the first copy (no handles). With snapping on
 * (`useDecalUi.snap`, Ctrl held frees one drag), a move pulls the centre onto the centre line or
 * another frame's height or vertical, a turn settles level (`decalSnap.ts`), and the snaps that
 * hold are drawn as dashed guides. Each drag is one undo step (`mergeKey` + `endGesture`). Mouse
 * only: the view's keys do the same from the keyboard (never snapped: the arrows are for exact
 * steps). Redrawn after every frame (the camera moves).
 */
export function DecalGizmo({ scene, layer, mirrorAxis, onGestureStart, onGestureEnd }: DecalGizmoProps) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const gesture = useRef<Gesture | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const snapOn = useDecalUi((s) => s.snap);
  useEffect(() => scene.onRender(redraw), [scene]);

  const decal = layer.decal;
  const corners = screenCorners(scene, decal);
  if (!corners) return null;
  const centre = scene.project(decal.center);
  const [tl, tr, br, bl] = corners as [Point, Point, Point, Point];
  const top = mid(tl, tr);
  const bottom = mid(bl, br);
  const upDir = sub(top, bottom);
  const upLen = len(upDir) || 1;
  const handle = { x: top.x + (upDir.x / upLen) * ROTATE_OFFSET, y: top.y + (upDir.y / upLen) * ROTATE_OFFSET };
  const id = layer.id;
  // Shift frees the ratio of pictures and shapes; text keeps its measured aspect, merged objects scale uniformly.
  const freeRatio = layer.kind === 'image' || layer.kind === 'shape';
  // Shapes: the midpoints of the top, right, bottom and left sides, each stretching one axis.
  const edges = layer.kind === 'shape' ? [top, mid(tr, br), bottom, mid(bl, tl)] : [];
  const repeat = layer.repeat && layer.repeat.count >= 2 ? layer.repeat : undefined;
  const envelope = repeat ? screenCorners(scene, envelopeOf(decal, repeat)) : null;

  const local = (e: PointerEvent<SVGElement>): Point => {
    const svg = e.currentTarget.ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement);
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const begin = (e: PointerEvent<SVGElement>, g: Gesture) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    useAtelierEditor.getState().endGesture();
    gesture.current = g;
    onGestureStart();
  };

  const onMove = (e: PointerEvent<SVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const at = local(e);
    const store = useAtelierEditor.getState();
    const current = liveDecal(id);
    if (!current) return;
    const snapping = snapOn && !e.ctrlKey;
    if (g.kind === 'move') {
      // Only its own part group, and never onto a surface turned too far (see `slideOnto`).
      const hit = scene.raycast(at.x - g.offset.x, at.y - g.offset.y, partGroupOf(current.part));
      if (!hit) return;
      let next = slideOnto(current, hit.point, hit.normal);
      let held: SnapGuide[] = [];
      if (snapping) {
        // Bound: `Scene.project` reads its own camera (passed bare, it threw and the decal stayed put).
        const project = (p: Vec3) => scene.project(p);
        const unitsPerPx = unitsPerPixel(project, next.center, decalRight(next), Math.max(next.width, next.height) / 2);
        ({ decal: next, guides: held } = snapMove(next, { mirrorAxis, others: otherDecals(id), unitsPerPx }));
      }
      setGuides(held);
      store.setDecal(id, next, 'move');
    } else if (g.kind === 'edge') {
      // One axis: the drag measured along that axis's direction on screen.
      const { right, up } = screenAxes(scene, g.decal, g.centre);
      const k = axisScale(sub(g.start, g.centre), sub(at, g.centre), g.axis === 'x' ? right : up);
      store.setDecal(id, g.axis === 'x' ? scaleDecal(g.decal, k, 1) : scaleDecal(g.decal, 1, k), 'scale');
    } else if (g.kind === 'scale') {
      const from = sub(g.start, g.centre);
      const to = sub(at, g.centre);
      if (e.shiftKey && freeRatio) {
        // Free ratio: the drag along the decal's own screen axes.
        const { right, up } = screenAxes(scene, g.decal, g.centre);
        store.setDecal(id, scaleDecal(g.decal, axisScale(from, to, right), axisScale(from, to, up)), 'scale');
      } else {
        store.setDecal(id, scaleDecal(g.decal, len(to) / Math.max(1, len(from))), 'scale');
      }
    } else {
      const v = sub(at, g.centre);
      let delta = Math.atan2(v.y, v.x) - g.start;
      if (e.shiftKey) {
        const snap = (ROTATE_SNAP_DEG * Math.PI) / 180;
        delta = Math.round(delta / snap) * snap;
      }
      const turned = rotateDecal(g.decal, g.sign * delta);
      const level = snapping && !e.shiftKey ? snapLevel(turned) : { decal: turned, guides: [] };
      setGuides(level.guides);
      store.setDecal(id, level.decal, 'rotate');
    }
  };

  const onUp = (e: PointerEvent<SVGElement>) => {
    if (!gesture.current) return;
    gesture.current = null;
    setGuides([]);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    useAtelierEditor.getState().endGesture();
    onGestureEnd(id);
  };

  const handlers = { onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onLostPointerCapture: onUp };

  const startScale = (e: PointerEvent<SVGElement>) => begin(e, { kind: 'scale', centre, start: local(e), decal });
  // Top and bottom (even sides) stretch the height, right and left the width.
  const startEdge = (e: PointerEvent<SVGElement>, side: number) =>
    begin(e, { kind: 'edge', axis: side % 2 === 0 ? 'y' : 'x', centre, start: local(e), decal });
  const startRotate = (e: PointerEvent<SVGElement>) => {
    const v = sub(local(e), centre);
    // Seen from the front, a clockwise drag on screen (y down) turns the decal clockwise: a negative turn around its normal.
    const facingViewer = dot(scene.viewDirection(), decal.normal) < 0;
    begin(e, { kind: 'rotate', centre, start: Math.atan2(v.y, v.x), decal, sign: facingViewer ? -1 : 1 });
  };
  // Dashed when the layer is hidden; dimmed and dashed when the decal faces away from the camera.
  const awayFromCamera = dot(decal.normal, scene.viewDirection()) > 0;
  const dashed = !layer.visible || awayFromCamera;

  const guideLines = guides.flatMap((guide) => {
    const a = scene.project(guide.from);
    const b = scene.project(guide.to);
    return a.behind || b.behind ? [] : [{ kind: guide.kind, a, b }];
  });

  return (
    <svg aria-hidden data-facing={awayFromCamera ? 'away' : 'toward'} className={`pointer-events-none absolute inset-0 h-full w-full overflow-visible ${awayFromCamera ? 'opacity-50' : ''}`}>
      {guideLines.map((l, i) => (
        <line key={i} data-snap-guide={l.kind} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} className="stroke-ink-1 [stroke-dasharray:5_4]" strokeWidth={1} />
      ))}
      {envelope && <polygon data-gizmo="repeat" points={pointsOf(envelope)} className="fill-none stroke-amber [stroke-dasharray:4_3]" strokeWidth={1} />}
      <polygon
        data-gizmo="body"
        points={pointsOf(corners)}
        className={`pointer-events-auto cursor-move fill-amber-10 stroke-amber ${dashed ? '[stroke-dasharray:4_3]' : ''}`}
        strokeWidth={1.5}
        onPointerDown={(e) => begin(e, { kind: 'move', offset: sub(local(e), centre) })}
        {...handlers}
      />
      <line x1={top.x} y1={top.y} x2={handle.x} y2={handle.y} className="stroke-amber" strokeWidth={1.5} />
      <circle
        data-gizmo="rotate"
        cx={handle.x}
        cy={handle.y}
        r={6}
        className="pointer-events-auto cursor-grab fill-bg-1 stroke-amber"
        strokeWidth={1.5}
        onPointerDown={startRotate}
        {...handlers}
      />
      {corners.map((c, i) => (
        <rect
          key={i}
          data-gizmo={`corner-${i}`}
          x={c.x - 5}
          y={c.y - 5}
          width={10}
          height={10}
          rx={2}
          className={`pointer-events-auto fill-bg-1 stroke-amber ${i % 2 === 0 ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
          strokeWidth={1.5}
          onPointerDown={startScale}
          {...handlers}
        />
      ))}
      {edges.map((c, i) => {
        // The cursor follows the side's direction from the centre on screen.
        const across = Math.abs(c.x - centre.x) > Math.abs(c.y - centre.y);
        return (
          <rect
            key={i}
            data-gizmo={`edge-${i}`}
            x={c.x - 4}
            y={c.y - 4}
            width={8}
            height={8}
            rx={4}
            className={`pointer-events-auto fill-bg-1 stroke-amber ${across ? 'cursor-ew-resize' : 'cursor-ns-resize'}`}
            strokeWidth={1.5}
            onPointerDown={(e) => startEdge(e, i)}
            {...handlers}
          />
        );
      })}
    </svg>
  );
}

/**
 * With several layers selected: each selected placed frame outlined on the 3D view (no handles, no
 * pointer events), redrawn after every frame as the gizmo is.
 */
export function SelectionOutlines({ scene }: { scene: EngineScene }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => scene.onRender(redraw), [scene]);
  const layers = useAtelierEditor((s) => s.layers);
  const selectedIds = useAtelierEditor((s) => s.selectedIds);
  const outlines = selectedIds.flatMap((id) => {
    const decal = framedLayerOf(layers, id)?.decal;
    const corners = decal ? screenCorners(scene, decal) : null;
    return corners ? [{ id, points: pointsOf(corners) }] : [];
  });
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {outlines.map((o) => (
        <polygon key={o.id} data-selection-outline={o.id} points={o.points} className="fill-none stroke-amber" strokeWidth={1.5} />
      ))}
    </svg>
  );
}

function add3(c: readonly number[], axis: readonly number[], k: number): [number, number, number] {
  return [c[0]! + axis[0]! * k, c[1]! + axis[1]! * k, c[2]! + axis[2]! * k];
}
