import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resetAtelierEditor, useAtelierEditor } from '@/atelier/editorStore';
import type { TemplateImage } from '@/atelier/gl/baker';
import type { OrbitState } from '@/atelier/gl/scene';
import { maskOf } from '@/atelier/project';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorText } from '@/lib/errors';
import { toAppError } from '@/lib/tauri';
import { ATELIER_PROJECTS_KEY, useAtelierProject, useSetThumb, useTemplateTextures, useVehicleModel } from '@/queries/atelier';
import { useVehicleNames, useVehicles } from '@/queries/vehicles';
import { useAtelierUi } from '@/store/atelier';
import { toast } from '@/store/toasts';
import type { AtelierProjectSummary } from '@/types';
import { vehicleLabel } from '../Explore/exploreModel';
import { BRUSH_DEFAULT, enabledSlots, HARDNESS_DEFAULT, isTypingTarget, MASK_ROW_ID } from './editorModel';
import { EditorTopBar } from './EditorTopBar';
import type { Engine } from './engine';
import { LayersPanel } from './LayersPanel';
import { PartsList } from './PartsList';
import { PropertiesPanel, type BrushUi } from './PropertiesPanel';
import { useApply } from './useApply';
import { useAutosave } from './useAutosave';
import { Viewport, type BrushSettings } from './Viewport';

/** Side of the project thumbnail (PNG). */
const THUMB_SIZE = 512;

const GRID = 'grid min-h-0 flex-1 grid-cols-[232px_minmax(0,1fr)_272px] xl:grid-cols-[256px_minmax(0,1fr)_320px]';

/** Each project's camera for this session, so coming back to its editor finds the view as it was left. */
const savedViews = new Map<string, OrbitState>();

/**
 * The Atelier editor of one project (spec §2 "Editor layout"): top bar, layers and parts on the
 * left, the 3D view in the centre, the selected layer's properties on the right. The project is
 * loaded into the editor store once per project id (autosaves update the cached copy, never the
 * store); closing the project resets the store, visiting another screen keeps it (and its undo
 * history) for the way back.
 */
export function Editor({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useAtelierProject(id);
  const project = useAtelierEditor((s) => (s.project?.id === id ? s.project : null));
  const vehicles = useVehicles();
  const names = useVehicleNames();

  // Into the store once; a project the store already holds (back from another screen) stays as it is.
  useEffect(() => {
    if (query.data && useAtelierEditor.getState().project?.id !== id) useAtelierEditor.getState().load(query.data);
  }, [query.data, id]);

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

  // Thumbnail: after an apply, and when leaving if something changed (or the project has none).
  const { mutateAsync: setThumb } = useSetThumb();
  const thumbRevision = useRef(useAtelierEditor.getState().revision);
  const sendThumb = useCallback(
    (e: Engine) => {
      // A lost context draws nothing: keep the thumbnail there is.
      if (e.scene.contextLost()) return;
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
      png.then((bytes) => setThumb({ id, png: bytes })).catch((err: unknown) => console.warn('Atelier: thumbnail not saved', err));
    },
    [id, setThumb],
  );
  const onBeforeDispose = useCallback(
    (e: Engine) => {
      savedViews.set(id, e.scene.view());
      const hasThumb = qc.getQueryData<AtelierProjectSummary[]>(ATELIER_PROJECTS_KEY)?.find((p) => p.id === id)?.hasThumb;
      if (useAtelierEditor.getState().revision !== thumbRevision.current || hasThumb === false) sendThumb(e);
    },
    [qc, id, sendThumb],
  );

  // The thumbnail waits for the decal pictures (an engine disposed meanwhile reports a lost context).
  const onApplied = useCallback(
    (e: Engine) => {
      e.baker
        .whenReady()
        .then(() => sendThumb(e))
        .catch((err: unknown) => console.warn('Atelier: thumbnail not saved', err));
    },
    [sendThumb],
  );
  const apply = useApply({ projectId: id, model: model.data, engine: () => engineRef.current, flush, onApplied });

  // Closing the project (not visiting another screen) empties the store. Declared after
  // `useAutosave`, so its leave-save has taken its copy first.
  useEffect(
    () => () => {
      if (useAtelierUi.getState().openProjectId !== id) resetAtelierEditor();
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
  // A hidden mask protects nothing: the brush is off until it is shown again.
  const brushActive = maskSelected && (mask === undefined || mask.visible) && !showTemplate;
  const radiusScale = engine?.scene.boundingRadius ?? 1;
  const brush = useMemo<BrushSettings | null>(
    () => (brushActive ? { radius: brushUi.size * radiusScale, hardness: brushUi.hardness, erase: brushUi.erase, part: brushUi.part } : null),
    [brushActive, brushUi, radiusScale],
  );

  const vehicle = project ? vehicleLabel(vehicles, project.vehicle, names) : '';
  const fatal = query.error ?? model.error;
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
        />
        <PropertiesPanel brush={brushUi} onBrush={onBrush} />
      </div>
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
