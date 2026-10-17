import { Maximize, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorText } from '@/lib/errors';
import { toAppError } from '@/lib/tauri';
import { fetchAsset, putAsset, type RawPicture } from '@/queries/atelier';
import { confirm } from '@/store/confirm';
import { toast } from '@/store/toasts';
import { AtelierDialog } from './AtelierDialog';
import { Slider } from './controls';
import { framedLayerOf } from './decalOps';
import { noteAssetSize } from './decalUi';
import { alphaOf, paintDab, restoreSource, setAlpha, strokePoints, unionRect, type DirtyRect, type RestoreSource } from './refineEdge';

/** Undo steps kept inside the dialog (alpha snapshots). */
const UNDO_LIMIT = 10;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;

interface Loaded {
  picture: RawPicture;
  source: RestoreSource;
  /** The asset the layer showed when the dialog opened (a different one by Apply means it changed meanwhile). */
  assetId: string;
}

type Tool = 'erase' | 'restore';

/**
 * Refine edge: the layer's picture on a checkerboard, zoomable, with an erase / restore brush
 * on alpha only (restore reads the picture the cutout came from, see refineEdge.ts). Strokes can
 * be undone inside the dialog; Apply stores the result as a new picture (`atelier_asset_put`, raw
 * RGBA) and switches the layer to it as one undo step, keeping where it came from, so a later
 * Refine edge still restores the true original. Painting is mouse-only; the rest works from the keyboard.
 */
export function RefineEdgeDialog({ projectId, layerId, onClose }: { projectId: string; layerId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const statusId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('erase');
  const [size, setSize] = useState(0.04);
  const [hardness, setHardness] = useState(0.5);
  const [zoom, setZoom] = useState(1);
  const [changed, setChanged] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const display = useRef<ImageData | null>(null);
  const undo = useRef<Uint8Array[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const dirty = useRef<DirtyRect | null>(null);
  const frame = useRef<number | null>(null);

  // The picture and the one restore reads from (the cutout's source, or the picture itself).
  useEffect(() => {
    let stale = false;
    // A framed picture (top level or in a folder); pieces are never offered.
    const layer = framedLayerOf(useAtelierEditor.getState().layers, layerId);
    if (layer?.kind !== 'image') {
      onClose();
      return;
    }
    void (async () => {
      try {
        const picture = await fetchAsset(projectId, layer.assetId);
        let source: RawPicture | null = null;
        if (layer.sourceAssetId && layer.sourceAssetId !== layer.assetId) {
          try {
            source = await fetchAsset(projectId, layer.sourceAssetId);
          } catch {
            // The source is gone: restore falls back to the picture as it is.
          }
        }
        if (stale) return;
        noteAssetSize(layer.assetId, picture.width, picture.height);
        // Restore copies the picture first when it is its own source; the fetched buffer is then the editable copy.
        const restore = restoreSource(picture, source, layer.sourceOffset);
        setLoaded({ picture, source: restore, assetId: layer.assetId });
      } catch (e) {
        if (!stale) setLoadError(errorText(toAppError(e), t));
      }
    })();
    return () => {
      stale = true;
    };
    // Once per opening.
  }, []);

  const longSide = loaded ? Math.max(loaded.picture.width, loaded.picture.height) : 1;
  const radius = Math.max(1, size * longSide);

  /** Zoom that fits the picture in the view. */
  const fitZoom = useCallback(() => {
    const box = scrollRef.current;
    if (!loaded || !box) return 1;
    const k = Math.min((box.clientWidth - 16) / loaded.picture.width, (box.clientHeight - 16) / loaded.picture.height);
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(k) && k > 0 ? k : 1));
  }, [loaded]);

  // First draw: the whole picture, fitted.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!loaded || !canvas) return;
    const { width, height, rgba } = loaded.picture;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(width, height);
    image.data.set(rgba);
    display.current = image;
    ctx.putImageData(image, 0, 0);
    setZoom(fitZoom());
  }, [loaded, fitZoom]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  /** Copies the touched pixels to the canvas, once per frame. */
  const flush = () => {
    frame.current = null;
    const rect = dirty.current;
    dirty.current = null;
    const canvas = canvasRef.current;
    const image = display.current;
    if (!rect || !canvas || !image || !loaded) return;
    const { rgba, width } = loaded.picture;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const start = (y * width + rect.x) * 4;
      image.data.set(rgba.subarray(start, start + rect.w * 4), start);
    }
    canvas.getContext('2d')?.putImageData(image, 0, 0, rect.x, rect.y, rect.w, rect.h);
  };

  const toImage = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const w = loaded?.picture.width ?? 1;
    const h = loaded?.picture.height ?? 1;
    return { x: ((e.clientX - rect.left) * w) / Math.max(1, rect.width), y: ((e.clientY - rect.top) * h) / Math.max(1, rect.height) };
  };

  const dabTo = (to: { x: number; y: number }) => {
    if (!loaded) return;
    const from = last.current ?? to;
    const points = last.current ? strokePoints(from, to, radius) : [to];
    const { rgba, width, height } = loaded.picture;
    for (const p of points) dirty.current = unionRect(dirty.current, paintDab(rgba, width, height, { ...p, radius, hardness, erase: tool === 'erase' }, loaded.source));
    last.current = to;
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!loaded || e.button !== 0 || saving) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    undo.current = [...undo.current, alphaOf(loaded.picture.rgba)].slice(-UNDO_LIMIT);
    setUndoCount(undo.current.length);
    last.current = null;
    dabTo(toImage(e));
    setChanged(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (last.current) dabTo(toImage(e));
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    last.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const undoStroke = () => {
    const snapshot = undo.current.pop();
    if (!snapshot || !loaded) return;
    setAlpha(loaded.picture.rgba, snapshot);
    setUndoCount(undo.current.length);
    dirty.current = { x: 0, y: 0, w: loaded.picture.width, h: loaded.picture.height };
    flush();
    if (undo.current.length === 0) setChanged(false);
  };

  const zoomBy = (k: number) => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * k)));

  // Ctrl+wheel zooms (non-passive, so the page doesn't zoom).
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [loaded]);

  const apply = async () => {
    if (!loaded) return;
    if (!changed) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const ref = await putAsset(projectId, loaded.picture);
      noteAssetSize(ref.id, ref.width, ref.height);
      const store = useAtelierEditor.getState();
      const layer = framedLayerOf(store.layers, layerId);
      if (layer?.kind !== 'image' || layer.assetId !== loaded.assetId) {
        toast(t('atelier.refine.stale'));
        onClose();
        return;
      }
      // Restore keeps reading the true original: the first source, or this picture as it was.
      store.setLayerProps(layerId, {
        assetId: ref.id,
        sourceAssetId: layer.sourceAssetId ?? layer.assetId,
        sourceOffset: layer.sourceOffset ?? { x: 0, y: 0, w: loaded.picture.width, h: loaded.picture.height },
      });
      store.endGesture();
      onClose();
    } catch (e) {
      toast(errorText(toAppError(e), t));
      setSaving(false);
    }
  };

  /** Escape or ×: with brush strokes made, asks before dropping them (a click outside does nothing then). */
  const dismiss = async () => {
    if (saving) return;
    if (!changed) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: t('atelier.refine.discardTitle'),
      body: t('atelier.refine.discardBody'),
      confirmLabel: t('atelier.refine.discard'),
    });
    if (ok) onClose();
  };

  const z = zoom;
  return (
    <AtelierDialog
      title={t('atelier.refine.title')}
      closeLabel={t('atelier.refine.close')}
      onDismiss={() => void dismiss()}
      dismissOnOverlay={!changed}
      locked={saving}
      busy={!loaded || saving}
      describedBy={statusId}
      widthClass="w-[880px] h-[640px]"
      footer={
        <>
          <Button variant="ghost" size={32} onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size={32} onClick={() => void apply()} disabled={!loaded || saving}>
            {t('atelier.refine.apply')}
          </Button>
        </>
      }
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_200px] gap-5">
        <div className="relative flex min-h-0 min-w-0 flex-col gap-2">
          <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto rounded-ctl border border-line-2 bg-bg-1">
            {loadError ? (
              <p role="alert" className="p-4 text-body text-danger">
                {loadError}
              </p>
            ) : !loaded ? (
              <Skeleton className="absolute inset-2 rounded-ctl" />
            ) : (
              <div className="grid min-h-full min-w-full place-items-center p-2">
                <div className="relative bg-checker" style={{ width: loaded.picture.width * z, height: loaded.picture.height * z }}>
                  <canvas
                    ref={canvasRef}
                    aria-label={t('atelier.refine.canvas')}
                    className="block h-full w-full cursor-crosshair touch-none [image-rendering:pixelated]"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onPointerLeave={() => setCursor(null)}
                  />
                  {cursor && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute rounded-full border border-amber shadow-glow"
                      style={{ left: cursor.x - radius * z, top: cursor.y - radius * z, width: radius * z * 2, height: radius * z * 2 }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <IconButton label={t('atelier.refine.zoomOut')} onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={!loaded}>
              <ZoomOut size={14} strokeWidth={1.75} aria-hidden />
            </IconButton>
            <span className="w-12 text-center font-mono text-mono-sm text-ink-3">{Math.round(z * 100)}%</span>
            <IconButton label={t('atelier.refine.zoomIn')} onClick={() => zoomBy(ZOOM_STEP)} disabled={!loaded}>
              <ZoomIn size={14} strokeWidth={1.75} aria-hidden />
            </IconButton>
            <IconButton label={t('atelier.refine.fit')} onClick={() => setZoom(fitZoom())} disabled={!loaded}>
              <Maximize size={14} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <p id={statusId} className="text-meta text-ink-3">
            {t('atelier.refine.help')}
          </p>
          <SegmentedControl
            label={t('atelier.refine.tool')}
            value={tool}
            options={[
              { value: 'erase', label: t('atelier.refine.erase') },
              { value: 'restore', label: t('atelier.refine.restore') },
            ]}
            onChange={setTool}
            className="self-start"
          />
          <Slider
            label={t('atelier.refine.size')}
            value={size}
            min={0.005}
            max={0.2}
            step={0.005}
            format={() => t('atelier.refine.px', { value: Math.round(radius * 2) })}
            onChange={setSize}
          />
          <Slider label={t('atelier.refine.hardness')} value={hardness} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setHardness} />
          <Button size={28} onClick={undoStroke} disabled={undoCount === 0} className="self-start">
            <Undo2 size={14} strokeWidth={1.75} aria-hidden />
            {t('atelier.refine.undo')}
          </Button>
        </div>
      </div>
    </AtelierDialog>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-7 w-7 place-items-center rounded-ctl border border-line-3 bg-bg-4 text-ink-2 hover:border-line-4 hover:text-ink-1 disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120"
    >
      {children}
    </button>
  );
}
