import { ArrowLeft, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/cn';
import { useAtelierUi } from '@/store/atelier';
import { ApplyButton } from './ApplyButton';
import { checkedName, NAME_MAX } from './editorModel';
import type { ApplyState } from './useApply';
import type { SaveState } from './useAutosave';

interface EditorTopBarProps {
  vehicle: string;
  saveState: SaveState;
  showTemplate: boolean;
  onShowTemplate: (on: boolean) => void;
  apply: ApplyState;
  /** Why Apply can't run now (null: it can). */
  applyBlocked: string | null;
  onApply: () => void;
  /** An apply is running: the project can't change (undo, redo and renaming are off). */
  locked: boolean;
}

const ICON_BUTTON =
  'grid h-ctl w-ctl flex-none place-items-center rounded-ctl text-ink-3 enabled:hover:bg-bg-hover enabled:hover:text-ink-1 disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-120';

/**
 * The editor's top bar: back to the projects, the project name (edited in place) and vehicle, the
 * save state, undo / redo, the Template / Paint comparison and Apply to game.
 */
export function EditorTopBar({ vehicle, saveState, showTemplate, onShowTemplate, apply, applyBlocked, onApply, locked }: EditorTopBarProps) {
  const { t } = useTranslation();
  const close = useAtelierUi((s) => s.close);
  const canUndo = useAtelierEditor((s) => s.past.length > 0 && !s.stroking);
  const canRedo = useAtelierEditor((s) => s.future.length > 0 && !s.stroking);
  const undo = useAtelierEditor((s) => s.undo);
  const redo = useAtelierEditor((s) => s.redo);

  return (
    <div className="flex flex-none items-center gap-3.5 border-b border-line-2 bg-bg-2/70 px-6 py-3">
      <Button size={28} onClick={close}>
        <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
        {t('atelier.editor.back')}
      </Button>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <ProjectName locked={locked} />
        <span className="min-w-0 flex-none truncate text-meta text-ink-3 max-xl:max-w-[160px]" title={vehicle}>
          {vehicle}
        </span>
        <SaveIndicator state={saveState} />
      </div>
      <div className="flex flex-none items-center gap-0.5">
        <button type="button" className={ICON_BUTTON} disabled={!canUndo || locked} onClick={undo} aria-label={t('atelier.editor.undo')} title={t('atelier.editor.undoHint')}>
          <Undo2 size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className={ICON_BUTTON} disabled={!canRedo || locked} onClick={redo} aria-label={t('atelier.editor.redo')} title={t('atelier.editor.redoHint')}>
          <Redo2 size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <SegmentedControl
        label={t('atelier.editor.compare')}
        value={showTemplate ? 'template' : 'paint'}
        options={[
          { value: 'paint', label: t('atelier.editor.paint') },
          { value: 'template', label: t('atelier.editor.template') },
        ]}
        onChange={(v) => onShowTemplate(v === 'template')}
      />
      <ApplyButton state={apply} blocked={applyBlocked} onApply={onApply} />
    </div>
  );
}

/** The project name as the page's heading, edited in place (Enter or leaving keeps it, Escape goes back). */
function ProjectName({ locked }: { locked: boolean }) {
  const { t } = useTranslation();
  const name = useAtelierEditor((s) => s.project?.name ?? '');
  const setName = useAtelierEditor((s) => s.setName);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    const next = checkedName(draft);
    if (next === null || next === name) setDraft(name);
    else setName(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(name);
      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
    }
  };

  return (
    <h1 className="min-w-0 flex-initial text-heading">
      <input
        value={draft}
        maxLength={NAME_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label={t('atelier.editor.nameLabel')}
        title={t('atelier.editor.nameHint')}
        spellCheck={false}
        readOnly={locked}
        size={Math.max(4, Math.min(40, [...draft].length + 1))}
        className="-mx-1.5 h-ctl max-w-full rounded-ctl border border-transparent bg-transparent px-1.5 text-heading text-ink-1 outline-none hover:border-line-3 focus:border-line-4 focus:bg-bg-input motion-safe:transition-colors motion-safe:duration-120"
      />
    </h1>
  );
}

/** Saved / Saving… / Couldn't save; only a failed save is announced (autosaves happen all the time). */
function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  const text = state === 'saved' ? t('atelier.editor.saved') : state === 'saving' ? t('atelier.editor.saving') : t('atelier.editor.saveError');
  return (
    <>
      <span className={cn('flex-none font-mono text-mono-sm', state === 'error' ? 'text-danger' : 'text-ink-4')}>{text}</span>
      <span role="alert" className="sr-only">
        {state === 'error' ? text : ''}
      </span>
    </>
  );
}
