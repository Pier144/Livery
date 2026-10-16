import { useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import type { TemplateImage } from '@/atelier/gl/baker';
import { QUICK_VIEWS, type QuickView } from '@/atelier/gl/scene';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import { maskOf, type PartFilter, type Vec3 } from '@/atelier/project';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
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
}

type Drag = { kind: 'orbit' | 'pan'; x: number; y: number } | { kind: 'paint' };

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
export function Viewport({ model, templates, label, showTemplate, brush, onEngine, onBeforeDispose }: ViewportProps) {
  const { t } = useTranslation();
  const factory = useContext(EngineContext);
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; r: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** Where the stroke being drawn was last sampled (CSS px), and the brush's radius on screen there. */
  const lastPainted = useRef<{ x: number; y: number } | null>(null);
  const cursorPx = useRef(0);
  const frame = useRef<number | null>(null);
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const callbacks = useRef({ onEngine, onBeforeDispose });
  callbacks.current = { onEngine, onBeforeDispose };

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
      return;
    }
    engineRef.current = engine;
    const sync = (s = useAtelierEditor.getState()) => {
      if (!s.project) return;
      engine.baker.setLayers(s.layers, enabledSlots(s.project, model));
    };
    sync();
    const unsubscribe = useAtelierEditor.subscribe((s, prev) => {
      if (s.layers !== prev.layers || s.project?.slots !== prev.project?.slots) sync(s);
    });
    callbacks.current.onEngine(engine);
    return () => {
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
  }, [showTemplate, failed]);

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

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      engineRef.current?.scene.zoomBy(e.deltaY);
      schedule();
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
    // `schedule` only reads refs.
  }, []);

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
    let kind: 'orbit' | 'pan' | null = null;
    if (e.button === 0) kind = 'orbit';
    else if (e.button === 2) kind = settings ? 'orbit' : 'pan';
    else if (e.button === 1) kind = 'pan';
    if (!kind) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    pointer.current = local(e);
    const d = drag.current;
    if (d && d.kind !== 'paint') {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      drag.current = { ...d, x: e.clientX, y: e.clientY };
      if (d.kind === 'orbit') engine.scene.orbitBy(dx, dy);
      else engine.scene.panBy(dx, dy);
    }
    if (brushRef.current) schedule();
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.kind === 'paint') useAtelierEditor.getState().endStroke();
  };

  const onPointerLeave = () => {
    if (drag.current) return;
    pointer.current = null;
    setCursor(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const scene = engineRef.current?.scene;
    if (!scene || e.ctrlKey || e.metaKey || e.altKey) return;
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
  return (
    <div className="relative min-h-0 min-w-0 overflow-hidden bg-bg-0 bg-grid">
      <div
        ref={hostRef}
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-describedby={helpId}
        className={cn(
          'absolute inset-0 touch-none outline-none focus-visible:outline focus-visible:-outline-offset-2',
          brush ? 'cursor-none' : 'cursor-grab active:cursor-grabbing',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
      />
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
        <p id={helpId} className="min-w-0 truncate rounded-tag bg-bg-scrim px-2 py-1 text-meta text-ink-3 max-xl:sr-only">
          {brush ? t('atelier.view.brushHelp') : t('atelier.view.help')}
        </p>
      </div>
    </div>
  );
}
