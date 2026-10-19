import type { QuickView } from '@/atelier/gl/scene';
import type { AtelierProject, PartGroup } from '@/types';

/**
 * The agent CLI's job, as Rust sends it (`CliCommand::page_job` in
 * `src-tauri/src/cli/args.rs`): keep the two in step. The `--out` folder is never in it; the page
 * names its files and Rust writes them there (`cli_file`).
 */

/** A view as typed on the command line: a quick view or an orbit round the model's centre. */
export type ViewArg = { kind: 'quick'; name: QuickView } | { kind: 'orbit'; theta: number; phi: number; zoom: number };

export type CliJob =
  | { command: 'put'; project: AtelierProject }
  | { command: 'vehicleInfo'; vehicle: string }
  | {
      command: 'place';
      id: string;
      view: ViewArg;
      at: [number, number];
      part: PartGroup | null;
      width: number | null;
      height: number | null;
      depth: number | null;
    }
  | { command: 'render'; id: string; views: ViewArg[]; size: number; grid: boolean; flat: boolean }
  | { command: 'apply'; id: string };

/** A failure the page reports through `cli_finish` (an `AppError` or a CLI-only code such as `noHit`). */
export interface CliError {
  code: string;
  message: string;
  detail?: string | null;
}
