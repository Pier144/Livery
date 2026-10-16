import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorText } from '@/lib/errors';
import { listenEvent } from '@/lib/events';
import { formatBytes } from '@/lib/format';
import { toAppError } from '@/lib/tauri';
import { cancelCutoutWork, CUTOUT_STATUS_KEY, cutoutAsset, downloadCutoutFiles, fetchAsset, fetchCutoutStatus } from '@/queries/atelier';
import en from '@/i18n/en.json';
import { toast } from '@/store/toasts';
import { EVENTS, type CutoutProgress, type CutoutStatus, type CutoutStep, type DownloadItem, type DownloadProgress } from '@/types';
import { AtelierDialog, ProgressBar } from './AtelierDialog';
import { assetSize, noteAssetSize, setCutoutBusy } from './decalUi';

type Retry = 'status' | 'download' | 'cutout';

type Phase =
  | { kind: 'checking' }
  | { kind: 'consent'; bytes: number }
  | { kind: 'restart' }
  | { kind: 'downloading'; items: Partial<Record<DownloadItem, { received: number; total: number }>> }
  | { kind: 'cutting'; step: CutoutStep | null }
  | { kind: 'error'; message: string; retry: Retry };

const STEPS: readonly CutoutStep[] = ['load', 'run', 'write'];
const ITEMS: readonly DownloadItem[] = ['runtime', 'model'];

const ready = (s: CutoutStatus) => s.runtime && s.model && !s.pendingRemoval;

/** The backend's answers to a cancel (`atelier_cutout_cancel`): ended quietly, never shown as errors. */
const CANCEL_MESSAGES = new Set<string>([en.common.errors.backend.downloadCancelled, en.common.errors.backend.cutoutCancelled]);
/** A download refused because removed files wait for a restart. */
const RESTART_NEEDED = en.common.errors.backend.cutoutRestartNeeded;

/**
 * Remove background for one image layer (spec §1 "Cutout"): reads whether the files are on this
 * PC; if not, says what gets downloaded (ONNX Runtime by Microsoft and the isnet-anime model by
 * SkyTNT via rembg, from GitHub, the size, stored on this PC, pictures never leave it) and waits
 * for Download; then the download's progress, then the cutout's, each with Cancel. The result is
 * one undo step (`applyCutout`): a new picture, the original kept, the decal refitted so the
 * subject stays where it was. A removal waiting for a restart says so instead of downloading.
 * A cancel ends quietly. A failed status read retries the read (never a download); a cutout
 * that finds its files gone reads the status again and asks to download them.
 */
export function CutoutDownloadDialog({ projectId, layerId, onClose }: { projectId: string; layerId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bodyId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const working = phase.kind === 'downloading' || phase.kind === 'cutting';

  const show = useCallback((p: Phase) => {
    if (mounted.current) setPhase(p);
  }, []);

  /** Reads the status fresh and shows what it means: restart, consent, or (when `cutWhenReady`) the cutout. */
  const check = useRef<(cutWhenReady: boolean, readyError?: string) => Promise<void>>(async () => {});

  const failed = useCallback(
    (e: unknown, from: Retry) => {
      const error = toAppError(e);
      if (cancelled.current || CANCEL_MESSAGES.has(error.message)) {
        onClose();
        return;
      }
      if (from === 'download' && error.message === RESTART_NEEDED) {
        show({ kind: 'restart' });
        return;
      }
      const message = errorText(error, t);
      // The files went away (removed in Settings meanwhile): ask for them again.
      if (from === 'cutout' && error.code === 'notFound') {
        void check.current(false, message);
        return;
      }
      show({ kind: 'error', message, retry: from });
    },
    [onClose, show, t],
  );

  const cut = useCallback(async () => {
    const layer = useAtelierEditor.getState().layers.find((l) => l.id === layerId);
    if (layer?.kind !== 'image') {
      onClose();
      return;
    }
    const sourceId = layer.assetId;
    cancelled.current = false;
    show({ kind: 'cutting', step: null });
    let unlisten = () => {};
    try {
      setCutoutBusy(true);
      unlisten = await listenEvent<CutoutProgress>(EVENTS.atelierCutoutProgress, (p) => show({ kind: 'cutting', step: p.step }));
      const result = await cutoutAsset(projectId, sourceId);
      let size = assetSize(sourceId);
      if (!size) {
        const picture = await fetchAsset(projectId, sourceId);
        size = { width: picture.width, height: picture.height };
        noteAssetSize(sourceId, size.width, size.height);
      }
      noteAssetSize(result.asset.id, result.asset.width, result.asset.height);
      if (cancelled.current) {
        onClose();
        return;
      }
      const store = useAtelierEditor.getState();
      const before = store.revision;
      store.applyCutout(layerId, result.asset, result.crop, { id: sourceId, ...size });
      // Ignored when the layer changed meanwhile (undo, another edit of its picture).
      toast(useAtelierEditor.getState().revision !== before ? t('atelier.cutout.done') : t('atelier.cutout.stale'));
      onClose();
    } catch (e) {
      failed(e, 'cutout');
    } finally {
      unlisten();
      setCutoutBusy(false);
    }
  }, [failed, layerId, onClose, projectId, show, t]);

  /** Bumped when the dialog's effects are torn down (StrictMode re-runs them): an older read is dropped. */
  const run = useRef(0);
  check.current = async (cutWhenReady, readyError) => {
    const mine = run.current;
    const current = () => mounted.current && mine === run.current;
    show({ kind: 'checking' });
    try {
      const status = await fetchCutoutStatus();
      qc.setQueryData(CUTOUT_STATUS_KEY, status);
      if (!current()) return;
      if (status.pendingRemoval) show({ kind: 'restart' });
      else if (!ready(status)) show({ kind: 'consent', bytes: status.downloadBytes });
      else if (cutWhenReady) await cut();
      else show({ kind: 'error', message: readyError ?? t('atelier.cutout.title'), retry: 'cutout' });
    } catch (e) {
      if (current()) failed(e, 'status');
    }
  };

  const download = useCallback(async () => {
    cancelled.current = false;
    show({ kind: 'downloading', items: {} });
    const items: Partial<Record<DownloadItem, { received: number; total: number }>> = {};
    let unlisten = () => {};
    let status: CutoutStatus;
    try {
      setCutoutBusy(true);
      unlisten = await listenEvent<DownloadProgress>(EVENTS.atelierDownloadProgress, (p) => {
        items[p.item] = { received: p.received, total: p.total };
        show({ kind: 'downloading', items: { ...items } });
      });
      status = await downloadCutoutFiles();
      qc.setQueryData(CUTOUT_STATUS_KEY, status);
    } catch (e) {
      void qc.invalidateQueries({ queryKey: CUTOUT_STATUS_KEY });
      failed(e, 'download');
      return;
    } finally {
      unlisten();
      setCutoutBusy(false);
    }
    if (cancelled.current) {
      onClose();
      return;
    }
    if (ready(status)) await cut();
    else show({ kind: 'consent', bytes: status.downloadBytes });
  }, [cut, failed, onClose, qc, show]);

  // First the status (read fresh): ready → straight to the cutout.
  useEffect(() => {
    mounted.current = true;
    void check.current(true);
    return () => {
      mounted.current = false;
      run.current += 1;
    };
    // Once per opening.
  }, []);

  const retry = (from: Retry) => {
    if (from === 'cutout') void cut();
    else if (from === 'download') void download();
    else void check.current(true);
  };

  useEffect(() => {
    if (phase.kind === 'consent' || phase.kind === 'error' || phase.kind === 'restart') primaryRef.current?.focus();
  }, [phase.kind]);

  const cancel = () => {
    if (!working) {
      onClose();
      return;
    }
    cancelled.current = true;
    void cancelCutoutWork().catch(() => {});
  };

  let body: ReactNode;
  let footer: ReactNode;
  switch (phase.kind) {
    case 'checking':
      body = (
        <div role="status" className="flex items-center gap-2 text-meta text-ink-3">
          <Skeleton className="h-2 w-12 flex-none rounded-tag" />
          {t('atelier.cutout.checking')}
        </div>
      );
      footer = (
        <Button variant="ghost" size={32} onClick={onClose}>
          {t('common.cancel')}
        </Button>
      );
      break;
    case 'consent':
      body = (
        <div id={bodyId} className="flex flex-col gap-3 text-body text-ink-2">
          <p>{t('atelier.cutout.consent')}</p>
          <ul className="flex flex-col rounded-card border border-line-2">
            <li className="flex items-baseline justify-between gap-3 border-b border-line-2 px-3.5 py-2.5">
              <span className="text-ink-1">{t('atelier.cutout.runtime')}</span>
              <span className="font-mono text-mono-sm text-ink-3">Microsoft · MIT</span>
            </li>
            <li className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
              <span className="text-ink-1">{t('atelier.cutout.model')}</span>
              <span className="font-mono text-mono-sm text-ink-3">SkyTNT · Apache-2.0</span>
            </li>
          </ul>
          <p className="text-ink-3">{t('atelier.cutout.privacy', { size: formatBytes(phase.bytes) })}</p>
        </div>
      );
      footer = (
        <>
          <Button variant="ghost" size={32} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button ref={primaryRef} variant="primary" size={32} onClick={() => void download()}>
            {t('atelier.cutout.download', { size: formatBytes(phase.bytes) })}
          </Button>
        </>
      );
      break;
    case 'restart':
      body = (
        <p id={bodyId} className="text-body text-ink-2">
          {t('atelier.cutout.restart')}
        </p>
      );
      footer = (
        <Button ref={primaryRef} variant="secondary" size={32} onClick={onClose}>
          {t('atelier.cutout.close')}
        </Button>
      );
      break;
    case 'downloading':
      body = (
        <div id={bodyId} className="flex flex-col gap-4">
          <p className="text-body text-ink-2">{t('atelier.cutout.downloading')}</p>
          {ITEMS.map((item) => {
            const p = phase.items[item];
            const label = t(item === 'runtime' ? 'atelier.cutout.runtime' : 'atelier.cutout.model');
            const text = p ? t('atelier.cutout.received', { received: formatBytes(p.received), total: formatBytes(p.total) }) : t('atelier.cutout.waiting');
            return (
              <div key={item} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-meta">
                  <span className="text-ink-2">{label}</span>
                  <span className="font-mono text-mono-sm text-ink-3">{text}</span>
                </div>
                <ProgressBar label={label} value={p && p.total > 0 ? p.received / p.total : null} valueText={text} />
              </div>
            );
          })}
        </div>
      );
      footer = (
        <Button variant="secondary" size={32} onClick={cancel}>
          {t('common.cancel')}
        </Button>
      );
      break;
    case 'cutting': {
      const text = t(`atelier.cutout.step.${phase.step ?? 'load'}`);
      body = (
        <div id={bodyId} className="flex flex-col gap-3">
          <p className="text-body text-ink-2">{text}</p>
          {/* Until the backend's first step arrives, an indeterminate stripe; then a quarter per step. */}
          <ProgressBar
            label={t('atelier.cutout.progress')}
            value={phase.step ? (STEPS.indexOf(phase.step) + 1) / (STEPS.length + 1) : null}
            indeterminate={phase.step === null}
            valueText={text}
          />
          <p className="text-meta text-ink-4">{t('atelier.cutout.local')}</p>
        </div>
      );
      footer = (
        <Button variant="secondary" size={32} onClick={cancel}>
          {t('common.cancel')}
        </Button>
      );
      break;
    }
    case 'error':
      body = (
        <p id={bodyId} role="alert" className="text-body text-danger">
          {phase.message}
        </p>
      );
      footer = (
        <>
          <Button variant="ghost" size={32} onClick={onClose}>
            {t('atelier.cutout.close')}
          </Button>
          <Button ref={primaryRef} variant="primary" size={32} onClick={() => retry(phase.retry)}>
            {t('atelier.cutout.retry')}
          </Button>
        </>
      );
      break;
  }

  return (
    <AtelierDialog
      title={t('atelier.cutout.title')}
      closeLabel={t('atelier.cutout.close')}
      onDismiss={onClose}
      locked={working}
      busy={working || phase.kind === 'checking'}
      describedBy={phase.kind === 'checking' ? undefined : bodyId}
      footer={footer}
    >
      {body}
    </AtelierDialog>
  );
}
