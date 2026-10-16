import { MoreHorizontal } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { formatSavedAt } from '@/lib/format';
import { useThumb } from '@/queries/atelier';
import type { AtelierProjectSummary } from '@/types';

/** Longest project name the backend accepts (`PROJECT_NAME_INVALID`: 1 to 80 characters). */
export const MAX_PROJECT_NAME = 80;

type CardAction = 'open' | 'rename' | 'duplicate' | 'delete';
const ACTIONS: readonly CardAction[] = ['open', 'rename', 'duplicate', 'delete'];

export interface ProjectCardProps {
  project: AtelierProjectSummary;
  /** The vehicle's name in the UI language (its code when the catalog doesn't know it). */
  vehicleLabel: string;
  /** Id of the hidden hint every card's button points at (its keys). */
  hintId: string;
  onOpen: (project: AtelierProjectSummary) => void;
  /** Resolves to false when the name was refused (the field stays open). */
  onRename: (project: AtelierProjectSummary, name: string) => Promise<boolean>;
  onDuplicate: (project: AtelierProjectSummary) => void;
  onDelete: (project: AtelierProjectSummary) => void;
}

/**
 * An Atelier project in the home grid, drawn like My Hangar's cards: 16:9 picture (the project's
 * thumbnail, else the stripes), name, vehicle and last edit. The whole card is a button that opens
 * the project (click, Enter or Space; F2 renames, Delete deletes); it sits *under* the other
 * controls so the actions menu isn't nested in a button (axe `nested-interactive`).
 */
export const ProjectCard = memo(function ProjectCard({ project, vehicleLabel, hintId, onOpen, onRename, onDuplicate, onDelete }: ProjectCardProps) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const nameId = useId();
  const edited = formatSavedAt(project.updatedAt, i18n.language);

  const endRename = () => {
    setEditing(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const act = (action: CardAction) => {
    if (action === 'open') onOpen(project);
    else if (action === 'rename') setEditing(true);
    else if (action === 'duplicate') onDuplicate(project);
    else onDelete(project);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Delete' && !e.repeat) {
      e.preventDefault();
      onDelete(project);
    } else if (e.key === 'F2') {
      e.preventDefault();
      setEditing(true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Space would scroll the grid; Enter would repeat while held.
      e.preventDefault();
      if (!e.repeat) onOpen(project);
    }
  };

  return (
    <div
      data-project-id={project.id}
      // Not a named group: the card's button already says the name (it would be read twice).
      className={cn(
        'group relative flex min-w-0 flex-col rounded-card border border-line-2 bg-bg-3 hover:border-line-mark motion-safe:transition-[border-color,transform] motion-safe:duration-150 motion-safe:ease-decel motion-safe:hover:-translate-y-px',
        // The open menu draws over the cards of the next row.
        menuOpen && 'z-10',
      )}
    >
      <div
        ref={buttonRef}
        role="button"
        tabIndex={0}
        aria-label={project.name}
        aria-describedby={hintId}
        title={project.name}
        onClick={() => onOpen(project)}
        onKeyDown={onKeyDown}
        className="absolute inset-0 cursor-pointer rounded-card"
      />
      <ProjectThumb id={project.id} hasThumb={project.hasThumb} className="aspect-video rounded-t-[7px] bg-placeholder" />
      <div className="flex min-w-0 flex-col gap-[5px] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 text-body font-medium leading-[normal] text-ink-1">
            <ProjectName id={nameId} project={project} editing={editing} onRename={onRename} onDone={endRename} />
          </div>
          <Menu
            items={ACTIONS.map((value) => ({ value, label: t(`atelier.card.${value}`) }))}
            onSelect={(value) => act(value as CardAction)}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
            className="z-[1] flex-none"
            renderTrigger={(props) => (
              <button
                {...props}
                aria-label={t('atelier.card.actions')}
                // "Project actions" repeats on every card: the name tells them apart.
                aria-describedby={editing ? undefined : nameId}
                title={t('atelier.card.actions')}
                className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-line-3 bg-bg-4 text-ink-3 hover:border-line-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
              >
                <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          />
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] leading-[normal]">
          <span className="min-w-0 truncate text-ink-3">{vehicleLabel}</span>
          {edited && (
            <time dateTime={project.updatedAt} className="flex-none font-mono text-[10px] text-ink-4">
              {t('atelier.card.edited', { date: edited })}
            </time>
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * The project's name, or a text field while renaming: Enter or leaving the field saves, Escape
 * cancels, a blank or unchanged name changes nothing. A refused name keeps the field open.
 */
function ProjectName({
  id,
  project,
  editing,
  onRename,
  onDone,
}: {
  id: string;
  project: AtelierProjectSummary;
  editing: boolean;
  onRename: ProjectCardProps['onRename'];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const saving = useRef(false);
  // Set once Enter saved or Escape cancelled: the blur that follows the field's removal (WebView2
  // fires one) must not save again.
  const finished = useRef(false);
  useEffect(() => {
    if (editing) finished.current = false;
  }, [editing]);
  if (!editing) return <span id={id} className="truncate">{project.name}</span>;
  const finish = () => {
    finished.current = true;
    onDone();
  };
  const save = async (input: HTMLInputElement) => {
    if (saving.current || finished.current) return;
    const next = input.value.trim();
    if (!next || next === project.name) return finish();
    saving.current = true;
    const ok = await onRename(project, next);
    saving.current = false;
    if (ok) finish();
    else input.focus();
  };
  return (
    <input
      // Opened on purpose by Rename / F2.
      autoFocus
      defaultValue={project.name}
      maxLength={MAX_PROJECT_NAME}
      aria-label={t('atelier.card.renameLabel', { name: project.name })}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void save(e.currentTarget);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish();
        }
      }}
      onBlur={(e) => void save(e.currentTarget)}
      onClick={(e) => e.stopPropagation()}
      className="relative z-[1] h-6 w-full min-w-0 rounded-[5px] border border-amber bg-bg-input px-1.5 text-body font-medium leading-none text-ink-1 outline-none"
    />
  );
}

/**
 * The project's thumbnail (a PNG from `atelier_project_thumb_get`) over the striped placeholder,
 * which shows until it loads and when there is none. Decorative: the card names the project.
 */
function ProjectThumb({ id, hasThumb, className }: { id: string; hasThumb: boolean; className?: string }) {
  const png = useThumb(id, hasThumb).data;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!png) {
      setSrc(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [png]);
  return (
    <span aria-hidden className={cn('pointer-events-none relative block overflow-hidden', className)}>
      {src && hasThumb && (
        <img
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-250 motion-safe:ease-decel motion-safe:group-hover:scale-[1.03]"
        />
      )}
    </span>
  );
}
