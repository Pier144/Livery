import { call, callRaw, toAppError } from '@/lib/tauri';
import { createEngine } from '@/screens/Atelier/engine';
import { isCliError, type CliJob } from './job';
import { runJob } from './runner';

/**
 * The agent CLI's hidden page (`cli.html`): asks Rust for the job, runs it with the editor's own
 * scene and Baker (`runner.ts`), and answers with `cli_finish`. No UI. Every exception ends as a
 * `cli_finish` error, so the run never waits for the timeout because of the page.
 */
async function main(): Promise<void> {
  try {
    const job = await call<CliJob>('cli_job');
    const ok = await runJob(job, { call, callRaw, createEngine, canvas: () => document.createElement('canvas') });
    await call('cli_finish', { ok, error: null });
  } catch (e) {
    const err = isCliError(e) ? e : toAppError(e);
    await call('cli_finish', { ok: null, error: { code: err.code, message: err.message, detail: err.detail ?? null } });
  }
}

void main();
