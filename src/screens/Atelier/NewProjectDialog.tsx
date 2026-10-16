import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { TextInput } from '@/components/ui/TextInput';
import { VehiclePicker } from '@/components/VehiclePicker';
import { errorText } from '@/lib/errors';
import { useCreateProject } from '@/queries/atelier';
import { useVehicleNames, useVehicles } from '@/queries/vehicles';
import type { AtelierProject, VehicleType } from '@/types';
import { vehicleLabel } from '../Explore/exploreModel';
import { MAX_PROJECT_NAME } from './ProjectCard';

/** Atelier paints ground vehicles for now. */
const GROUND: readonly VehicleType[] = ['ground'];

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

/**
 * New project: a ground vehicle (only listed ones) and a name, which follows the vehicle's name
 * until the user types their own. Create asks the backend, which reads the vehicle's model first:
 * meanwhile a shimmer line says so, and when the model can't be read the dialog shows why and
 * nothing is created. Modal like Licenses: focus starts in the vehicle field, Tab cycles inside,
 * Escape or a click outside closes (not while creating), focus goes back to the opener.
 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: AtelierProject) => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const vehicleId = useId();
  const nameId = useId();
  const statusId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const vehicleRef = useRef<HTMLDivElement>(null);

  const vehicles = useVehicles();
  const names = useVehicleNames();
  const create = useCreateProject();
  const busy = create.isPending;

  const [vehicle, setVehicle] = useState<string | null>(null);
  const [name, setName] = useState('');
  // The name follows the vehicle until the user edits it.
  const [nameTouched, setNameTouched] = useState(false);
  const suggested = vehicle ? vehicleLabel(vehicles, vehicle, names).slice(0, MAX_PROJECT_NAME) : '';
  const shownName = nameTouched ? name : suggested;
  const canCreate = vehicle !== null && shownName.trim() !== '' && !busy;

  // Read during the first render, before the vehicle field takes focus.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    vehicleRef.current?.querySelector('input')?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, [opener]);

  const { reset } = create;
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canCreate || !vehicle) return;
    create.mutate({ name: shownName.trim(), vehicle }, { onSuccess: onCreated });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The fields stop the Escapes they use (closing the suggestions, clearing the vehicle).
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const dialog = dialogRef.current;
      const focusables = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && !!dialog?.contains(active) && active !== dialog;
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first?.focus();
      }
    }
    // Keys stay in the modal (section shortcuts, Delete on a card underneath); Ctrl/Cmd combos still reach the window.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 motion-safe:animate-overlay-in" onMouseDown={onOverlayMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        // No overflow clipping: the vehicle suggestions may hang below the dialog.
        className="flex w-[440px] max-w-full flex-col rounded-dialog border border-line-4 bg-bg-3 shadow-dialog outline-none motion-safe:animate-dialog-in"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-2 py-3.5 pl-6 pr-4">
          <h2 id={titleId} className="text-heading-lg text-ink-1">
            {t('atelier.newProject.title')}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={t('atelier.newProject.close')}
            title={t('atelier.newProject.close')}
            className="grid h-7 w-7 flex-none place-items-center rounded-ctl text-ink-3 hover:bg-bg-hover hover:text-ink-1 disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="flex flex-col gap-4 px-6 py-5">
            <div ref={vehicleRef} className="flex flex-col gap-1.5">
              <label id={`${vehicleId}-label`} htmlFor={vehicleId} className="text-meta font-medium text-ink-2">
                {t('atelier.newProject.vehicle')}
              </label>
              <VehiclePicker
                id={vehicleId}
                aria-labelledby={`${vehicleId}-label`}
                value={vehicle}
                onChange={(code) => {
                  setVehicle(code);
                  if (create.isError) reset();
                }}
                list={vehicles}
                types={GROUND}
                allowFreeText={false}
                placeholder={t('atelier.newProject.vehiclePlaceholder')}
                className="w-full"
              />
              <p className="text-meta text-ink-4">
                {t('atelier.newProject.vehicleHelper')}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameId} className="text-meta font-medium text-ink-2">
                {t('atelier.newProject.name')}
              </label>
              <TextInput
                id={nameId}
                type="text"
                value={shownName}
                onValueChange={(next) => {
                  setName(next);
                  setNameTouched(true);
                }}
                maxLength={MAX_PROJECT_NAME}
                disabled={busy}
                className="w-full"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line-2 px-6 py-3.5">
            <div id={statusId} role="status" className="min-w-0 text-meta">
              {busy ? (
                <span className="flex items-center gap-2 text-ink-3">
                  <Skeleton className="h-2 w-12 flex-none rounded-tag" />
                  {t('atelier.newProject.reading')}
                </span>
              ) : create.isError ? (
                <span className="text-danger">{errorText(create.error, t)}</span>
              ) : null}
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button variant="ghost" size={32} onClick={close} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" size={32} disabled={!canCreate} aria-describedby={statusId}>
                {t('atelier.newProject.create')}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
