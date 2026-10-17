import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resetAtelierEditor, useAtelierEditor } from '@/atelier/editorStore';
import type { TemplateImage } from '@/atelier/gl/baker';
import type { OrbitState } from '@/atelier/gl/scene';
import { framedLayerOf, textLayers } from '@/atelier/layerTree';
import { envelopeOf } from '@/atelier/merge';
import { maskOf, type Decal, type Layer, type Repeat } from '@/atelier/project';
import { fontStatus, loadFont } from '@/atelier/text';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorText } from '@/lib/errors';
import { call, toAppError } from '@/lib/tauri';
import { ATELIER_PROJECTS_KEY, atelierProjectKey, openProjectAssets, useSetThumb, useTemplateTextures, useVehicleModel } from '@/queries/atelier';
import { useVehicleNames, useVehicles } from '@/queries/vehicles';
import { useAtelierUi } from '@/store/atelier';
import { toast } from '@/store/toasts';
import type { AppError, AtelierProject, AtelierProjectSummary } from '@/types';
import { vehicleLabel } from '../Explore/exploreModel';
import { CutoutDownloadDialog } from './CutoutDownloadDialog';
import { bumpFonts, resetDecalUi, setPlacingLayer, setShared, useDecalUi } from './decalUi';
import { BRUSH_DEFAULT, enabledSlots, HARDNESS_DEFAULT, isTypingTarget, MASK_ROW_ID } from './editorModel';
import { EditorTopBar } from './EditorTopBar';
import type { Engine } from './engine';
import { LayersPanel } from './LayersPanel';
import { PartsList } from './PartsList';
import { PropertiesPanel, type BrushUi } from './PropertiesPanel';
import { RefineEdgeDialog } from './RefineEdgeDialog';
import { useApply } from './useApply';
import { savesSettled, useAutosave } from './useAutosave';
import { Viewport, type BrushSettings } from './Viewport';

/** Side of the project thumbnail (PNG). */
const THUMB_SIZE = 512;

const GRID = 'grid min-h-0 flex-1 grid-cols-[232px_minmax(0,1fr)_272px] xl:grid-cols-[256px_minmax(0,1fr)_320px]';

/** Each project's camera for this session, so coming back to its editor finds the view as it was left. */
const savedViews = new Map<string, OrbitState>();

/**
 * Opens project `id` into the editor store, unless the store already holds it (back from another
 * screen: it stays as it is, with its undo history). In this order: every save still on its way
 * (a closed editor's leave-save) finishes, the backend drops pictures nothing uses
 * (`atelier_project_open`, which reads the saved file), and the project is read fresh (never the
 * cached copy) and loaded. A failed cleanup isn't fatal. Returns the read's error, if any.
 */
function useOpenProject(id: string): AppError | null {
  const qc = useQueryClient();
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    if (useAtelierEditor.getState().project?.id === id) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      await savesSettled();
      if (cancelled) return;
      try {
        await openProjectAssets(id);
      } catch (e) {
        console.warn('Atelier: unused pictures not cleaned up', e);
      }
      if (cancelled) return;
      const fresh = await qc.fetchQuery({
        queryKey: atelierProjectKey(id),
        queryFn: () => call<AtelierProject>('atelier_project_get', { id }),
        staleTime: 0,
      });
      if (cancelled || useAtelierEditor.getState().project?.id === id) return;
      resetDecalUi();
      useAtelierEditor.getState().load(fresh);
    })().catch((e: unknown) => {
      if (!cancelled) setError(toAppError(e));
    });
    return () => {
      cancelled = true;
    };
  }, [id, qc]);
  return error;
}

/**
 * Text layers' fonts (in folders and merged objects too): loaded once each (the stand-in measures
 * meanwhile), then the layers and pieces using them re-measured.
 */
function useTextFonts() {
  useEffect(() => {
    const load = (layers: readonly Layer[]) => {
      for (const layer of textLayers(layers)) {
        const font = layer.font;
        if (fontStatus(font) !== undefined) continue;
        void loadFont(font).then(() => {
          bumpFonts();
          const store = useAtelierEditor.getState();
          for (const l of textLayers(store.layers)) {
            if (l.font.family === font.family && l.font.style === font.style) store.refreshTextMetrics(l.id);
          }
        });
      }
    };
    load(useAtelierEditor.getState().layers);
    return useAtelierEditor.subscribe((s, prev) => {
      if (s.layers !== prev.layers) load(s.layers);
    });
  }, []);
}

/**
 * The Atelier editor of one project (spec §2 "Editor layout"): top bar, layers and parts on the
 * left, the 3D view in the centre, the selected layer's properties on the right. The project is
 * loaded into the editor store once per project id (`useOpenProject`; autosaves update the
 * cached copy, never the store); closing the project resets the store, visiting another screen
 * keeps it (and its undo history) for the way back.
 */
export function Editor({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const openError = useOpenProject(id);
  const project = useAtelierEditor((s) => (s.project?.id === id ? s.project : null));
  const vehicles = useVehicles();
  const names = useVehicleNames();
  useTextFonts();

  const { saveState, flush } = useAutosave();
  const model = useVehicleModel(project?.vehicle ?? null);
  const slotNames = useMemo(() => model.data?.header.slots.map((s) => s.texture) ?? [], [model.data]);
  const templateQueries = useTemplateTextures(project?.vehicle ?? null, slotNames);
  const templatesSettled = templateQueries.every((q) => !q.isPending);
  const templateData = templateQueries.map((q) => q.data);
  const templateStamp = templateQueries.map((q) => q.dataUpdatedAt).join(',');
  const templateError = templateQueries.find((q) => q.error)?.error ?? null;

  const templates = useMemo(() => {
    if (!model.data || !templatesSettled) return null;
    const map = new Map<string, TemplateImage>();
    model.data.header.slots.forEach((slot, i) => {
      const rgba = templateData[i];
      if (rgba && rgba.length === slot.width * slot.height * 4) map.set(slot.texture, { rgba, w: slot.width, h: slot.height });
    });
    return map;
    // `templateStamp` changes whenever one of `templateData` does.
  }, [model.data, templatesSettled, templateStamp]);

  // A missing texture isn't fatal: that part shows plain grey under the paint.
  const toastedTemplate = useRef(false);
  useEffect(() => {
    if (!templateError || toastedTemplate.current) return;
    toastedTemplate.current = true;
    toast(errorText(toAppError(templateError), t));
  }, [templateError, t]);

  const [engine, setEngine] = useState<Engine | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  const engineRef = useRef<Engine | null>(null);
  const onEngine = useCallback(
    (e: Engine | null) => {
      engineRef.current = e;
      const saved = savedViews.get(id);
      if (e && saved) e.scene.setView(saved);
      setEngine(e);
    },
    [id],
  );
  const onViewFailed = useCallback(() => setViewFailed(true), []);
  const [showTemplate, setShowTemplate] = useState(false);
  const showTemplateRef = useRef(showTemplate);
  showTemplateRef.current = showTemplate;

  // Thumbnail: during an apply (before the commit, so the skin's preview.png is the fresh one),
  // and when leaving if something changed (or the project has none).
  const { mutateAsync: setThumb } = useSetThumb();
  const thumbRevision = useRef(useAtelierEditor.getState().revision);
  const sendThumb = useCallback(
    (e: Engine): Promise<unknown> => {
      // A lost context draws nothing: keep the thumbnail there is.
      if (e.scene.contextLost()) return Promise.resolve();
      thumbRevision.current = useAtelierEditor.getState().revision;
      // The picture shows the paint, never the Template comparison.
      const template = showTemplateRef.current;
      if (template) e.baker.setShowTemplate(false);
      let png: Promise<Uint8Array>;
      try {
        e.baker.upgrade();
        png = e.scene.thumbnailPng(THUMB_SIZE);
      } finally {
        if (template) e.baker.setShowTemplate(true);
      }
      return png.then((bytes) => setThumb({ id, png: bytes })).catch((err: unknown) => console.warn('Atelier: thumbnail not saved', err));
    },
    [id, setThumb],
  );
  // Whether the Baker has the pictures of the current layers (a thumbnail without its decals isn't taken).
  const picturesSettled = useRef(true);
  useEffect(() => {
    if (!engine) return;
    let generation = 0;
    const check = () => {
      const mine = ++generation;
      picturesSettled.current = false;
      // After the viewport gave the Baker the new layers (its listener runs in the same update).
      queueMicrotask(() => {
        engine.baker
          .whenReady()
          .then(() => {
            if (mine === generation) picturesSettled.current = true;
          })
          .catch(() => {});
      });
    };
    check();
    const unsubscribe = useAtelierEditor.subscribe((s, prev) => {
      if (s.layers !== prev.layers) check();
    });
    return () => {
      unsubscribe();
      generation = -1;
    };
  }, [engine]);

  const onBeforeDispose = useCallback(
    (e: Engine) => {
      savedViews.set(id, e.scene.view());
      // Leaving before the decal pictures loaded: the thumbnail there is stays (it would miss them).
      if (!picturesSettled.current) return;
      const hasThumb = qc.getQueryData<AtelierProjectSummary[]>(ATELIER_PROJECTS_KEY)?.find((p) => p.id === id)?.hasThumb;
      if (useAtelierEditor.getState().revision !== thumbRevision.current || hasThumb === false) void sendThumb(e);
    },
    [qc, id, sendThumb],
  );

  // Before the commit: Rust copies the project's thumbnail into the installed skin as preview.png.
  // It waits for the decal pictures; a failure never stops the apply.
  const beforeCommit = useCallback(
    async (e: Engine) => {
      try {
        await e.baker.whenReady();
        await sendThumb(e);
      } catch (err) {
        console.warn('Atelier: thumbnail not saved', err);
      }
    },
    [sendThumb],
  );
  const apply = useApply({ projectId: id, model: model.data, engine: () => engineRef.current, flush, beforeCommit });

  // Closing the project (not visiting another screen) empties the store. Declared after
  // `useAutosave`, so its leave-save has taken its copy first.
  useEffect(
    () => () => {
      if (useAtelierUi.getState().openProjectId !== id) {
        resetAtelierEditor();
        resetDecalUi();
      }
    },
    [id],
  );

  // Editing is locked while an apply runs: what was saved is what gets baked.
  const locked = apply.state.running;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gridRef.current?.toggleAttribute('inert', locked);
  });

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z: the editor's history (text fields keep their own). Taken only
  // when there is something to undo or redo, otherwise the window's toast Undo gets the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || isTypingTarget(e.target) || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = e.key.toLowerCase();
      const store = useAtelierEditor.getState();
      const undo = key === 'z' && !e.shiftKey;
      const redo = key === 'y' || (key === 'z' && e.shiftKey);
      if (undo && store.past.length > 0 && !store.stroking) {
        e.preventDefault();
        if (!lockedRef.current) store.undo();
      } else if (redo && store.future.length > 0 && !store.stroking) {
        e.preventDefault();
        if (!lockedRef.current) store.redo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The Protected areas row stays selected across the mask layer appearing (first stroke) and
  // going away (undoing it), so the brush stays in hand.
  useEffect(
    () =>
      useAtelierEditor.subscribe((s, prev) => {
        const now = maskOf(s.layers);
        const before = maskOf(prev.layers);
        if (now && s.selectedId === MASK_ROW_ID) s.select(now.id);
        else if (!now && before && prev.selectedId === before.id && s.selectedId !== MASK_ROW_ID) s.select(MASK_ROW_ID);
      }),
    [],
  );

  const [brushUi, setBrushUi] = useState<BrushUi>({ size: BRUSH_DEFAULT, hardness: HARDNESS_DEFAULT, erase: false, part: 'all' });
  const onBrush = useCallback((patch: Partial<BrushUi>) => setBrushUi((b) => ({ ...b, ...patch })), []);
  const mask = useAtelierEditor((s) => maskOf(s.layers));
  const selectedId = useAtelierEditor((s) => s.selectedId);
  const maskSelected = selectedId === MASK_ROW_ID || (mask !== undefined && selectedId === mask.id);
  // A layer waiting for its placement click: the view's left click places it (never paints).
  const pendingPlacement = useAtelierEditor((s) => s.pending !== null);
  const placingAgain = useDecalUi((s) => s.placingLayerId !== null);
  const placing = pendingPlacement || placingAgain;
  // A hidden mask protects nothing: the brush is off until it is shown again (and while placing).
  const brushActive = maskSelected && (mask === undefined || mask.visible) && !showTemplate && !placing;
  const radiusScale = engine?.scene.boundingRadius ?? 1;
  // Escape drops a layer waiting for its placement click (dialogs and text fields keep their own Escape).
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      useAtelierEditor.getState().cancelPlacement();
      setPlacingLayer(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [placing]);

  /**
   * Whether a layer's decal lands on texels more than one triangle draws (Mirror is then offered
   * off), remembered per layer. Asked again only when the decal, its repeat or the painted slots
   * changed.
   */
  const sharedChecks = useRef(new Map<string, { decal: Decal; repeat: Repeat | undefined; slots: unknown; result: Promise<boolean> }>());
  const checkShared = useCallback((layerId: string, decal?: Decal): Promise<boolean> => {
    const state = useAtelierEditor.getState();
    // Any framed layer, top level or in a folder (a merged object: its frame).
    const layer = framedLayerOf(state.layers, layerId);
    const target = decal ?? layer?.decal ?? null;
    const repeat = layer?.repeat;
    const e = engineRef.current;
    if (!target || !e) return Promise.resolve(false);
    const slots = state.project?.slots;
    const last = sharedChecks.current.get(layerId);
    if (last && last.decal === target && last.repeat === repeat && last.slots === slots) return last.result;
    // Every repeat copy is checked: the envelope covers the whole row or column.
    const result = e.baker.decalTouchesSharedTexels(envelopeOf(target, repeat)).then(
      (shared) => {
        setShared(layerId, shared);
        return shared;
      },
      (err: unknown) => {
        console.warn('Atelier: shared-texel check failed', err);
        sharedChecks.current.delete(layerId);
        return false;
      },
    );
    sharedChecks.current.set(layerId, { decal: target, repeat, slots, result });
    return result;
  }, []);
  // The selected decal is checked when it gets selected, when a gesture ends, after undo / redo
  // and when the painted slots change (never in the middle of a drag).
  useEffect(() => {
    if (!engine) return;
    const run = (s: ReturnType<typeof useAtelierEditor.getState>) => {
      if (s.mergeKey !== null || s.stroking) return;
      const layer = framedLayerOf(s.layers, s.selectedId);
      if (layer?.decal) void checkShared(layer.id);
    };
    run(useAtelierEditor.getState());
    return useAtelierEditor.subscribe((s, prev) => {
      const gestureEnded = prev.mergeKey !== null && s.mergeKey === null;
      if (s.layers === prev.layers && s.project?.slots === prev.project?.slots && s.selectedId === prev.selectedId && !gestureEnded) return;
      run(s);
    });
  }, [engine, checkShared]);

  const [cutoutLayer, setCutoutLayer] = useState<string | null>(null);
  const [refineLayer, setRefineLayer] = useState<string | null>(null);

  const brush = useMemo<BrushSettings | null>(
    () => (brushActive ? { radius: brushUi.size * radiusScale, hardness: brushUi.hardness, erase: brushUi.erase, part: brushUi.part } : null),
    [brushActive, brushUi, radiusScale],
  );

  const vehicle = project ? vehicleLabel(vehicles, project.vehicle, names) : '';
  const fatal = openError ?? model.error;
  if (fatal && !project?.id) return <Failed message={errorText(toAppError(fatal), t)} />;
  if (model.error) return <Failed message={errorText(toAppError(model.error), t)} />;
  if (!project || !model.data || !templates) return <EditorLoading />;

  const blocked = apply.state.running
    ? null
    : enabledSlots(project, model.data).length === 0
      ? t('atelier.apply.nothing')
      : viewFailed
        ? t('atelier.apply.noView')
        : engine === null
          ? t('atelier.apply.notReady')
          : null;

  return (
    <section aria-label={project.name} className="flex h-full min-h-0 flex-col">
      <EditorTopBar
        vehicle={vehicle}
        saveState={saveState}
        showTemplate={showTemplate}
        onShowTemplate={setShowTemplate}
        apply={apply.state}
        applyBlocked={blocked}
        onApply={() => void apply.start()}
        locked={locked}
      />
      <div ref={gridRef} aria-busy={locked || undefined} className={GRID}>
        <aside aria-label={t('atelier.editor.sidebar')} className="flex min-h-0 flex-col overflow-y-auto border-r border-line-2 bg-bg-1">
          <LayersPanel />
          <PartsList model={model.data} />
        </aside>
        <Viewport
          model={model.data}
          templates={templates}
          label={t('atelier.view.canvas', { vehicle })}
          showTemplate={showTemplate}
          brush={brush}
          onEngine={onEngine}
          onBeforeDispose={onBeforeDispose}
          onFailed={onViewFailed}
          onDecalGestureEnd={checkShared}
        />
        <PropertiesPanel
          brush={brushUi}
          onBrush={onBrush}
          checkShared={checkShared}
          onRemoveBackground={setCutoutLayer}
          onRefineEdge={setRefineLayer}
          mirrorAxis={model.data.header.mirrorAxis}
        />
      </div>
      {cutoutLayer !== null && <CutoutDownloadDialog projectId={id} layerId={cutoutLayer} onClose={() => setCutoutLayer(null)} />}
      {refineLayer !== null && <RefineEdgeDialog projectId={id} layerId={refineLayer} onClose={() => setRefineLayer(null)} />}
    </section>
  );
}

function Failed({ message }: { message: string }) {
  const { t } = useTranslation();
  const close = useAtelierUi((s) => s.close);
  return (
    <section aria-label={t('common.nav.atelier')} className="flex h-full min-h-0 flex-col px-6 pt-4.5">
      <h1 className="sr-only">{t('atelier.editor.loadErrorTitle')}</h1>
      <EmptyState title={t('atelier.editor.loadErrorTitle')} body={message} primary={{ label: t('atelier.editor.back'), onClick: close }} />
    </section>
  );
}

/** While the project, its model and textures load: the editor's frame with skeletons. */
function EditorLoading() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="flex h-full min-h-0 flex-col">
      <span className="sr-only">{t('atelier.editor.loading')}</span>
      <div aria-hidden className="flex h-[55px] flex-none items-center gap-3.5 border-b border-line-2 bg-bg-2/70 px-6">
        <Skeleton className="h-ctl w-36 rounded-ctl" />
        <Skeleton className="h-4 w-48 rounded-tag" />
      </div>
      <div aria-hidden className={GRID}>
        <div className="flex flex-col gap-2 border-r border-line-2 bg-bg-1 p-4">
          <Skeleton className="h-[34px] rounded-ctl" />
          <Skeleton className="h-[34px] rounded-ctl" />
        </div>
        <Skeleton className="rounded-none" />
        <div className="flex flex-col gap-3 border-l border-line-2 bg-bg-1 p-5">
          <Skeleton className="h-4 w-32 rounded-tag" />
          <Skeleton className="h-ctl w-40 rounded-ctl" />
        </div>
      </div>
    </div>
  );
}
