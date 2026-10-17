import { Magnet } from 'lucide-react';
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { boundingDiagonal, defaultDecalSize, frameFromHit } from '@/atelier/decal';
import { useAtelierEditor } from '@/atelier/editorStore';
import type { TemplateImage } from '@/atelier/gl/baker';
import { QUICK_VIEWS, type QuickView } from '@/atelier/gl/scene';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import { dot, maskOf, partGroupOf, type Decal, type PartFilter, type PlacedLayer, type Vec3 } from '@/atelier/project';
import { measureTextAspect } from '@/atelier/text';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { DecalGizmo, SelectionOutlines } from './DecalGizmo';
import {
  decalCorners,
  framedLayerOf,
  nudgePoint,
  rotateDecal,
  ROTATE_STEP_DEG,
  scaleDecal,
  SCALE_STEP,
  shapePlaceAspect,
  slideOnto,
  wheelDepth,
} from './decalOps';
import { assetSize, setDrawTruncated, setPlacingLayer, setSnap, useDecalUi } from './decalUi';
import { distance, enabledSlots, POINT_SPACING } from './editorModel';
import { EngineContext, type Engine } from './engine';

/** The brush settings the viewport paints with (radius in model units). */
export interface BrushSettings {
  radius: number;
  hardness: number;
  erase: boolean;
  part: PartFilter;
}

interface ViewportProps {
  model: VehicleModelData;
  templates: Map<string, TemplateImage>;
  /** Accessible name of the view (the vehicle). */
  label: string;
  /** Template toggle: the game's textures alone. */
  showTemplate: boolean;
  /** Left drag paints Protected areas (the mask layer is selected and visible). */
  brush: BrushSettings | null;
  /** The engine once created (null when it goes away). */
  onEngine: (engine: Engine | null) => void;
  /** Called right before the engine is disposed (the last chance to read the view, e.g. a thumbnail). */
  onBeforeDispose?: (engine: Engine) => void;
  /** The engine couldn't start (no WebGL context): the view shows why. */
  onFailed?: () => void;
  /** A decal gesture (drag, key presses, placement) ended: one undo step was made. */
  onDecalGestureEnd?: (layerId: string) => void;
}

type Drag = { kind: 'orbit' | 'pan'; x: number; y: number; startX: number; startY: number; moved: boolean } | { kind: 'paint' };

/** A click that moved less than this (CSS px) places a layer instead of turning the view. */
const CLICK_SLOP = 4;
/** Alt+wheel depth edits end their undo step after this quiet time. */
const WHEEL_GESTURE_MS = 400;

/** A placed layer that has its frame. */
type Framed = PlacedLayer & { decal: Decal };

/**
 * The single selected framed layer (image, text, shape or merged object, top level or in a folder;
 * never a piece) when it is placed: its gizmo and keys apply. Null with several selected.
 */
function selectedPlaced(s: ReturnType<typeof useAtelierEditor.getState>): Framed | null {
  if (s.selectedIds.length > 1) return null;
  const layer = framedLayerOf(s.layers, s.selectedId);
  return layer?.decal ? (layer as Framed) : null;
}

/** Arrow keys turn the view this many pixels' worth; + and − zoom by this wheel delta. */
const KEY_ORBIT_PX = 24;
const KEY_ZOOM = 240;
/** Raycasts per frame at most when sampling a fast brush drag. */
const MAX_SAMPLES = 8;

/**
 * The 3D view: the vehicle drawn by the engine (scene + Baker), turned with the left button (or
 * right / Alt+left while the brush is active), moved with the right (middle while painting),
 * zoomed with the wheel; arrow keys and + / − do the same from the keyboard. With the brush, a
 * left drag adds a Protected-areas stroke: raycasts run once per animation frame and a point is
 * added whenever the brush moved a third of its radius.
 */
export function Viewport({ model, templates, label, showTemplate, brush, onEngine, onBeforeDispose, onFailed, onDecalGestureEnd }: ViewportProps) {
  const { t } = useTranslation();
  const factory = useContext(EngineContext);
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useAtelierEditor((s) => s.pending);
  const placingLayerId = useDecalUi((s) => s.placingLayerId);
  const snap = useDecalUi((s) => s.snap);
  const placing = pending !== null || placingLayerId !== null;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const decalLayer = useAtelierEditor((s) => (placing ? null : selectedPlaced(s)));
  const multiSelected = useAtelierEditor((s) => s.selectedIds.length > 1);
  const decalRef = useRef(decalLayer);
  decalRef.current = decalLayer;
  const [announcement, setAnnouncement] = useState('');
  const diagonal = useMemo(() => boundingDiagonal(model.positions), [model]);
  /** The layer whose decal keys are being held and the key that started it (one undo step until that key goes up). */
  const keyGesture = useRef<{ id: string; key: string } | null>(null);
  /** An Alt+wheel depth burst: its layer and the timer that ends its undo step. */
  const wheelGesture = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** A gizmo drag is running (Alt+wheel waits for it to end). */
  const gizmoDrag = useRef(false);
  const gestureEnd = useRef(onDecalGestureEnd);
  gestureEnd.current = onDecalGestureEnd;
  const [cursor, setCursor] = useState<{ x: number; y: number; r: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** Where the stroke being drawn was last sampled (CSS px), and the brush's radius on screen there. */
  const lastPainted = useRef<{ x: number; y: number } | null>(null);
  const cursorPx = useRef(0);
  const frame = useRef<number | null>(null);
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const callbacks = useRef({ onEngine, onBeforeDispose, onFailed });
  callbacks.current = { onEngine, onBeforeDispose, onFailed };
  const showTemplateRef = useRef(showTemplate);
  showTemplateRef.current = showTemplate;

  // The engine lives as long as the model and templates; the store's layers and slots drive the bake.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A fresh canvas per engine: a disposed engine loses its WebGL context for good.
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 block h-full w-full';
    host.appendChild(canvas);
    let engine: Engine;
    try {
      engine = factory({ canvas, model, templates });
    } catch (e) {
      console.error('Atelier: the 3D view could not start', e);
      canvas.remove();
      setFailed(true);
      callbacks.current.onFailed?.();
      return;
    }
    engineRef.current = engine;
    // A new engine starts showing the paint: give it the Template toggle as it is.
    engine.baker.setShowTemplate(showTemplateRef.current);
    const sync = (s = useAtelierEditor.getState()) => {
      if (!s.project) return;
      engine.baker.setLayers(s.layers, enabledSlots(s.project, model));
      setDrawTruncated(engine.baker.truncated);
    };
    sync();
    const unsubscribe = useAtelierEditor.subscribe((s, prev) => {
      if (s.layers !== prev.layers || s.project?.slots !== prev.project?.slots) sync(s);
    });
    callbacks.current.onEngine(engine);
    setEngine(engine);
    return () => {
      setEngine(null);
      unsubscribe();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (useAtelierEditor.getState().stroking) useAtelierEditor.getState().endStroke();
      try {
        callbacks.current.onBeforeDispose?.(engine);
      } catch (e) {
        console.error('Atelier: leaving the editor', e);
      }
      engineRef.current = null;
      callbacks.current.onEngine(null);
      engine.dispose();
      canvas.remove();
    };
  }, [factory, model, templates]);

  useEffect(() => {
    engineRef.current?.baker.setShowTemplate(showTemplate);
  }, [showTemplate]);

  // Leaving brush mode (another layer, the mask hidden) ends a stroke and hides the cursor.
  const brushOn = brush !== null;
  useEffect(() => {
    if (brushOn) return;
    setCursor(null);
    if (drag.current?.kind === 'paint') {
      drag.current = null;
      useAtelierEditor.getState().endStroke();
    }
  }, [brushOn]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling. With a decal
  // selected, Alt+wheel changes its depth instead (one undo step per wheel burst).
  useEffect(() => {
    const frameEl = frameRef.current;
    if (!frameEl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const layer = decalRef.current;
      if (e.altKey && layer) {
        if (gizmoDrag.current) return;
        const store = useAtelierEditor.getState();
        store.setDecal(layer.id, { depth: wheelDepth(layer.decal.depth, e.deltaY) }, 'depth');
        if (wheelGesture.current) clearTimeout(wheelGesture.current.timer);
        wheelGesture.current = { id: layer.id, timer: setTimeout(endWheelGesture, WHEEL_GESTURE_MS) };
        return;
      }
      engineRef.current?.scene.zoomBy(e.deltaY);
      schedule();
    };
    frameEl.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      frameEl.removeEventListener('wheel', onWheel);
      if (wheelGesture.current) clearTimeout(wheelGesture.current.timer);
      wheelGesture.current = null;
    };
    // `schedule` only reads refs.
  }, []);

  // A layer waiting for its placement: say so and give the view the keys (Enter, Escape).
  const placingKey = pending ? `new:${pending.kind}` : placingLayerId ? `again:${placingLayerId}` : null;
  useEffect(() => {
    if (!placingKey) return;
    setAnnouncement(t('atelier.place.start'));
    hostRef.current?.focus({ preventScroll: true });
  }, [placingKey, t]);

  /**
   * Places the waiting layer where the view shows the model at (`x`, `y`): the decal faces out
   * along the surface, its up the screen's, sized from the model (25% of its diagonal) and the
   * picture's or text's aspect (a shape placed again: square, a striped band 8:1; a merged object
   * square). False when nothing is there.
   */
  const placeAt = (x: number, y: number): boolean => {
    const e = engineRef.current;
    if (!e) return false;
    const hit = e.scene.raycast(x, y);
    if (!hit) {
      setAnnouncement(t('atelier.place.missed'));
      return false;
    }
    const store = useAtelierEditor.getState();
    const again = useDecalUi.getState().placingLayerId;
    const target = again ? framedLayerOf(store.layers, again) : null;
    let aspect = store.pending?.aspect ?? 1;
    if (!store.pending && target) {
      if (target.kind === 'image') {
        const size = assetSize(target.assetId);
        aspect = size ? size.width / size.height : 1;
      } else if (target.kind === 'text') {
        aspect = measureTextAspect(target) ?? 1;
      } else {
        aspect = shapePlaceAspect(target);
      }
    }
    const decal = frameFromHit(hit.point, hit.normal, e.scene.cameraMatrixWorld(), defaultDecalSize(diagonal, aspect));
    if (!decal) return false;
    let placed: string | null = null;
    if (store.pending) placed = store.placePending(decal);
    else if (again && target) {
      store.setDecal(again, decal);
      store.select(again);
      setPlacingLayer(null);
      placed = again;
    }
    if (!placed) return false;
    setAnnouncement(t('atelier.place.done'));
    gestureEnd.current?.(placed);
    return true;
  };

  /**
   * Slides the decal so its centre lands under the view point (`x`, `y`) on its own part group
   * (`slideOnto`: a surface turned more than 35° keeps the decal's orientation); false when that
   * misses the model.
   */
  const slideDecalTo = (layer: Framed, x: number, y: number, mergeKey: string): boolean => {
    const hit = engineRef.current?.scene.raycast(x, y, partGroupOf(layer.decal.part));
    if (!hit) return false;
    useAtelierEditor.getState().setDecal(layer.id, slideOnto(layer.decal, hit.point, hit.normal), mergeKey);
    return true;
  };

  /** Ends an Alt+wheel depth burst now (its undo step). */
  function endWheelGesture() {
    const wheel = wheelGesture.current;
    if (!wheel) return;
    clearTimeout(wheel.timer);
    wheelGesture.current = null;
    useAtelierEditor.getState().endGesture();
    gestureEnd.current?.(wheel.id);
  }

  /** Ends a decal gesture made with keys. */
  const endKeyGesture = () => {
    const held = keyGesture.current;
    if (!held) return;
    keyGesture.current = null;
    useAtelierEditor.getState().endGesture();
    gestureEnd.current?.(held.id);
  };

  /** One raycast for the latest pointer position: the cursor, and the stroke while painting. */
  /** Adds `point` to the stroke being drawn unless it is within a third of the radius of the last one. */
  const addPoint = (point: Vec3): void => {
    const store = useAtelierEditor.getState();
    if (!store.stroking) return;
    const stroke = maskOf(store.layers)?.strokes.at(-1);
    if (!stroke) return;
    const last = stroke.points.at(-1);
    if (last && distance(last, point) < stroke.radius * POINT_SPACING) return;
    store.extendStroke(point);
  };

  /**
   * One pass for the latest pointer position: the cursor, and while painting the stroke's new
   * points. A fast drag moves many pixels between frames, so the way from the last painted
   * position is sampled (at most `MAX_SAMPLES` raycasts) to keep the stroke continuous.
   */
  const trace = () => {
    const engine = engineRef.current;
    const at = pointer.current;
    const settings = brushRef.current;
    if (!engine || !at || !settings) {
      setCursor(null);
      return;
    }
    const painting = drag.current?.kind === 'paint' && useAtelierEditor.getState().stroking;
    const before = maskOf(useAtelierEditor.getState().layers)?.strokes.at(-1)?.points.length ?? 0;
    let hit = null;
    const from = lastPainted.current;
    if (painting && from) {
      const px = cursorPx.current > 0 ? cursorPx.current * POINT_SPACING : 4;
      const samples = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / Math.max(2, px))));
      for (let i = 1; i <= samples; i++) {
        const k = i / samples;
        hit = engine.scene.raycast(from.x + (at.x - from.x) * k, from.y + (at.y - from.y) * k);
        if (hit) addPoint(hit.point);
      }
    } else {
      hit = engine.scene.raycast(at.x, at.y);
      if (hit && painting) addPoint(hit.point);
    }
    if (painting) lastPainted.current = at;
    if (hit) cursorPx.current = engine.scene.pixelRadius(settings.radius, hit.distance);
    setCursor(hit ? { x: at.x, y: at.y, r: cursorPx.current } : null);
    if (!painting) return;
    const stroke = maskOf(useAtelierEditor.getState().layers)?.strokes.at(-1);
    if (stroke && stroke.points.length > before) engine.baker.stampStroke('all', stroke, before);
  };

  const schedule = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      trace();
    });
  };

  const local = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine || drag.current) return;
    e.currentTarget.focus({ preventScroll: true });
    const at = local(e);
    pointer.current = at;
    const settings = brushRef.current;
    if (settings && e.button === 0 && !e.altKey) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      drag.current = { kind: 'paint' };
      lastPainted.current = null;
      useAtelierEditor.getState().beginStroke({
        erase: settings.erase,
        radius: settings.radius,
        hardness: settings.hardness,
        part: settings.part,
        dir: engine.scene.viewDirection(),
      });
      // The first point right away (not a frame later).
      trace();
      return;
    }
    // With the brush or a decal, the right button turns the view (the left one is the tool's) and the middle one moves it.
    const tool = settings !== null || decalRef.current !== null;
    let kind: 'orbit' | 'pan' | null = null;
    if (e.button === 0) kind = 'orbit';
    else if (e.button === 2) kind = tool ? 'orbit' : 'pan';
    else if (e.button === 1) kind = 'pan';
    if (!kind) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    pointer.current = local(e);
    const d = drag.current;
    if (d && d.kind !== 'paint') {
      const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= CLICK_SLOP;
      // While placing, a click places: the view only turns once the pointer really moves.
      if (placingRef.current && !moved) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      drag.current = { ...d, x: e.clientX, y: e.clientY, moved };
      if (d.kind === 'orbit') engine.scene.orbitBy(dx, dy);
      else engine.scene.panBy(dx, dy);
    }
    if (brushRef.current) schedule();
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'paint') {
      // The way to where the button was released belongs to the stroke too.
      pointer.current = local(e);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      trace();
    }
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.kind === 'paint') useAtelierEditor.getState().endStroke();
    else if (placingRef.current && !d.moved && e.button === 0 && e.type === 'pointerup') placeAt(local(e).x, local(e).y);
  };

  /** The pointer was taken away (another window, a touch cancel): the drag ends where it was. */
  const onLostCapture = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.kind === 'paint') useAtelierEditor.getState().endStroke();
  };

  const onPointerLeave = () => {
    if (drag.current) return;
    pointer.current = null;
    setCursor(null);
  };

  /** The key that started a held-key gesture went up (+ and = are the same key): the gesture ends. */
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    const held = keyGesture.current;
    if (!held) return;
    const plus = (k: string) => k === '+' || k === '=';
    if (e.key === held.key || (plus(e.key) && plus(held.key))) endKeyGesture();
  };

  /**
   * Keys with a decal selected: arrows slide it on screen (re-raycast, so it follows the surface),
   * Shift+arrows turn it, + and − scale it, Alt+arrows (and Alt with + / −) move the view. Held
   * keys make one undo step. False when the key isn't one of these.
   */
  const decalKey = (e: KeyboardEvent<HTMLDivElement>, layer: Framed): boolean => {
    const scene = engineRef.current?.scene;
    if (!scene || e.ctrlKey || e.metaKey || e.altKey) return false;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const store = useAtelierEditor.getState();
    const arrow = arrows[e.key];
    if (arrow && e.shiftKey) {
      if (arrow[0] === 0) return false;
      // Shift+Left turns counter-clockwise as seen, Shift+Right clockwise.
      const facingViewer = dot(scene.viewDirection(), layer.decal.normal) < 0;
      const turn = ((-arrow[0] * ROTATE_STEP_DEG * Math.PI) / 180) * (facingViewer ? 1 : -1);
      store.setDecal(layer.id, rotateDecal(layer.decal, turn), 'key-rotate');
    } else if (arrow) {
      // A step of a twentieth of the decal's size on screen (at least 2 px), in the arrow's screen direction.
      const c = scene.project(layer.decal.center);
      const corners = decalCorners(layer.decal).map((p) => scene.project(p));
      const size = Math.max(...corners.map((p) => Math.hypot(p.x - c.x, p.y - c.y))) * 2;
      const step = Math.max(2, size / 20);
      if (!slideDecalTo(layer, c.x + arrow[0] * step, c.y + arrow[1] * step, 'key-move')) {
        // Off the model on screen: a step along the decal's own plane.
        store.setDecal(layer.id, { center: nudgePoint(layer.decal, arrow[0], -arrow[1]) }, 'key-move');
      }
    } else if (e.key === '+' || e.key === '=') {
      store.setDecal(layer.id, scaleDecal(layer.decal, SCALE_STEP), 'key-scale');
    } else if (e.key === '-') {
      store.setDecal(layer.id, scaleDecal(layer.decal, 1 / SCALE_STEP), 'key-scale');
    } else {
      return false;
    }
    if (keyGesture.current?.id !== layer.id || keyGesture.current.key !== e.key) keyGesture.current = { id: layer.id, key: e.key };
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const scene = engineRef.current?.scene;
    if (!scene) return;
    if (placingRef.current && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { width, height } = scene.viewSize();
      placeAt(width / 2, height / 2);
      return;
    }
    const layer = decalRef.current;
    if (layer && decalKey(e, layer)) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    // With a decal selected the view's keys need Alt; otherwise Alt is left to the system.
    if (e.altKey !== (layer !== null)) return;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => scene.orbitBy(-KEY_ORBIT_PX, 0),
      ArrowRight: () => scene.orbitBy(KEY_ORBIT_PX, 0),
      ArrowUp: () => scene.orbitBy(0, -KEY_ORBIT_PX),
      ArrowDown: () => scene.orbitBy(0, KEY_ORBIT_PX),
      '+': () => scene.zoomBy(-KEY_ZOOM),
      '=': () => scene.zoomBy(-KEY_ZOOM),
      '-': () => scene.zoomBy(KEY_ZOOM),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    move();
  };

  const quickView = (view: QuickView) => engineRef.current?.scene.quickView(view);

  if (failed) {
    return (
      <div className="grid min-h-0 min-w-0 place-items-center bg-bg-0">
        <EmptyState title={t('atelier.gate.webglTitle')} body={t('atelier.gate.webglBody')} />
      </div>
    );
  }

  const helpId = 'atelier-viewport-help';
  const help = placing ? t('atelier.place.hint') : brush ? t('atelier.view.brushHelp') : decalLayer ? t('atelier.view.decalHelp') : t('atelier.view.help');
  return (
    <div ref={frameRef} className="relative min-h-0 min-w-0 overflow-hidden bg-bg-0 bg-grid">
      <div
        ref={hostRef}
        tabIndex={0}
        role="application"
        aria-label={label}
        aria-describedby={helpId}
        className={cn(
          'absolute inset-0 touch-none outline-none focus-visible:outline focus-visible:-outline-offset-2',
          brush ? 'cursor-none' : placing ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={onLostCapture}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={endKeyGesture}
      />
      {engine && decalLayer && !brush && (
        <DecalGizmo
          scene={engine.scene}
          layer={decalLayer}
          mirrorAxis={model.header.mirrorAxis}
          onGestureStart={() => {
            // Whatever ran before (an Alt+wheel burst, held keys) ends here: the drag is its own step.
            endWheelGesture();
            endKeyGesture();
            gizmoDrag.current = true;
            hostRef.current?.focus({ preventScroll: true });
          }}
          onGestureEnd={(id) => {
            gizmoDrag.current = false;
            gestureEnd.current?.(id);
          }}
        />
      )}
      {engine && multiSelected && !brush && !placing && <SelectionOutlines scene={engine.scene} />}
      {placing && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
          <p className="rounded-ctl border border-amber-35 bg-bg-scrim px-3 py-1.5 text-meta text-ink-1">{t('atelier.place.hint')}</p>
        </div>
      )}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {brush && cursor && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-full border border-amber shadow-glow"
          style={{ left: cursor.x - cursor.r, top: cursor.y - cursor.r, width: cursor.r * 2, height: cursor.r * 2 }}
        >
          {brush.erase && <div className="absolute inset-0 rounded-full border border-dashed border-ink-1" />}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
        <div role="group" aria-label={t('atelier.view.label')} className="pointer-events-auto flex gap-1 rounded-ctl border border-line-3 bg-bg-scrim p-0.5">
          {QUICK_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => quickView(view)}
              className="h-[24px] rounded-tag px-2 text-meta leading-none text-ink-3 hover:bg-bg-hover hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
            >
              {t(`atelier.view.${view}`)}
            </button>
          ))}
        </div>
        {decalLayer && !brush && (
          <button
            type="button"
            aria-pressed={snap}
            title={t('atelier.view.snapHint')}
            aria-description={t('atelier.view.snapHint')}
            onClick={() => setSnap(!snap)}
            className={cn(
              'pointer-events-auto mr-auto flex h-[30px] items-center gap-1.5 rounded-ctl border bg-bg-scrim px-2.5 text-meta leading-none motion-safe:transition-colors motion-safe:duration-120',
              snap ? 'border-amber-35 text-ink-1' : 'border-line-3 text-ink-3 hover:text-ink-1',
            )}
          >
            <Magnet size={14} strokeWidth={1.75} aria-hidden className={snap ? 'text-amber' : undefined} />
            {t('atelier.view.snap')}
          </button>
        )}
        <p id={helpId} className="min-w-0 truncate rounded-tag bg-bg-scrim px-2 py-1 text-meta text-ink-3 max-xl:sr-only">
          {help}
        </p>
      </div>
    </div>
  );
}
