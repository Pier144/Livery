import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/chrome/Toaster';
import { useInstallEvents } from '@/hooks/useInstallEvents';
import i18n from '@/i18n';
import { createQueryClient } from '@/queries/client';
import { HANGAR_KEY } from '@/queries/hangar';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/queries/settings';
import { useQueue } from '@/store/queue';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { EVENTS, type HangarSkin, type InstallProgress, type QueueItem, type Settings, type Vehicle } from '@/types';
import { Queue } from '../Queue';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  open: vi.fn<(options: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@/lib/events', () => ({
  listenEvent: (name: string, handler: (payload: unknown) => void) => {
    backend.listeners.set(name, handler);
    return Promise.resolve(() => backend.listeners.delete(name));
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (options: unknown) => backend.open(options),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const vehicle = (code: string, name: string): Vehicle => ({ code, name, nation: 'GER', type: 'ground', class: '' });
const TIGER = vehicle('germ_pzkpfw_VI_ausf_b_tiger_IIH', 'Tiger II (H)');
const LEO = vehicle('germ_leopard_2a4', 'Leopard 2A4');
const SU27 = vehicle('su_27', 'Su-27');
const SU27SM = vehicle('su_27sm', 'Su-27SM');
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `t${i}.dds`, sizeBytes: MB }));

const HANGAR: HangarSkin[] = [
  { id: 'h1', folder: 'Bundeswehr Flecktarn', name: 'Bundeswehr Flecktarn', vehicle: LEO, origin: 'imported', sizeBytes: MB, active: true, installedAt: '2026-09-19T10:00:00Z' },
];

const q = (id: string, fileName: string, extra: Partial<QueueItem>): QueueItem => ({
  id,
  path: `C:\\Downloads\\${fileName}`,
  fileName,
  sizeBytes: 31 * MB,
  status: 'ready',
  ...extra,
});

const READY = q('q-ready', 'tiger2_h_ambush_winter.zip', { vehicle: TIGER, files: files(5), textureCount: 4, blkOk: true, targetFolder: 'Tiger ambush winter' });
const READY_2 = q('q-ready2', 'tiger2_desert.zip', { vehicle: TIGER, files: files(3), textureCount: 2, blkOk: true, targetFolder: 'Tiger desert' });
const CONFLICT = q('q-conflict', 'leopard_flecktarn_v2.zip', { status: 'conflict', vehicle: LEO, conflictWith: 'h1', targetFolder: 'Bundeswehr Flecktarn' });
const LOOK = q('q-look', 'Su-27 pack', { status: 'needsLook', sizeBytes: 12 * MB, candidates: [SU27, SU27SM] });
const INSTALLING = q('q-installing', 'f4e_sea.zip', { status: 'installing', vehicle: vehicle('f_4e', 'F-4E Phantom II') });
const DONE = q('q-done', 't34_winter.zip', { status: 'done', vehicle: vehicle('ussr_t_34_85', 'T-34-85') });
const ERROR = q('q-error', 'mig29_desert.7z', { status: 'error', sizeBytes: 20 * MB, error: '7z archives can be unpacked once their library is approved.' });
const ANALYZING = q('p-1', 'new_drop.zip', { status: 'analyzing', sizeBytes: 0 });
const ALL = [READY, CONFLICT, LOOK, INSTALLING, DONE, ERROR, ANALYZING];

/** What the fake backend answers. */
let analyses: Record<string, QueueItem>;
let installReply: (args: Args) => unknown;
let watchReply: (args: Args) => unknown;

function installBackend(settings: Settings) {
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    switch (cmd) {
      case 'get_hangar':
        return HANGAR;
      case 'get_settings':
        return settings;
      case 'list_queue':
        return [];
      case 'analyze_archive': {
        const r = analyses[args.path as string];
        if (!r) throw { code: 'invalidInput', message: 'Not a skin folder or archive' };
        return r;
      }
      case 'install_from_archive':
        return installReply(args);
      case 'remove_queue_item':
        return null;
      case 'undo_replace':
        return { ...HANGAR[0], id: 'h1-restored' };
      case 'watch_folder':
        return watchReply(args);
      default:
        throw { code: 'noBackend', message: `unexpected ${cmd}` };
    }
  });
}

function Events() {
  useInstallEvents();
  return null;
}

function renderQueue(items: QueueItem[], settings: Partial<Settings> = {}) {
  const full: Settings = { ...DEFAULT_SETTINGS, onboarded: true, watchFolder: 'C:\\Users\\me\\Downloads', ...settings };
  installBackend(full);
  useQueue.setState({ items });
  const client = createQueryClient();
  client.setQueryData(HANGAR_KEY, HANGAR);
  client.setQueryData(SETTINGS_KEY, full);
  return renderWithProviders(
    <>
      <Queue />
      <Events />
      <Toaster />
    </>,
    { client },
  );
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const row = (fileName: string) => screen.getByText(fileName).closest('li') as HTMLElement;
const toasts = () => screen.getByRole('region', { name: 'Notifications' });

function emitProgress(event: InstallProgress) {
  act(() => backend.listeners.get(EVENTS.installProgress)?.(event));
}

beforeEach(() => {
  resetStores();
  useQueue.setState({ installs: {}, picked: {}, batchRunning: false });
  backend.call.mockReset();
  backend.open.mockReset();
  backend.listeners.clear();
  analyses = {};
  installReply = (args) => ({ installId: `i-${String(args.queueId)}` });
  watchReply = (args) => ({ ...DEFAULT_SETTINGS, onboarded: true, autoInstall: args.enabled, watchFolder: args.path ?? 'C:\\Users\\me\\Downloads' });
  // Events are applied on the next frame; run frames at once so updates land inside act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Install queue — rows', () => {
  it('shows every status with its line and action', () => {
    renderQueue(ALL);
    expect(screen.getByRole('heading', { level: 1, name: 'Install queue' })).toBeInTheDocument();
    expect(screen.getByText('7 archives · 1 ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install 1 ready' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear installed' })).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'Queued items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);

    const ready = row(READY.fileName);
    expect(ready).toHaveTextContent('Ready · Tiger II (H) · 5 files · 4 textures · skin.blk ok');
    expect(ready).toHaveTextContent('31 MB');
    expect(within(ready).getByRole('button', { name: 'Install' })).toHaveAccessibleDescription(READY.fileName);

    const conflict = row(CONFLICT.fileName);
    expect(conflict).toHaveTextContent('Conflict · Leopard 2A4 · Same folder name as “Bundeswehr Flecktarn” (installed)');
    expect(within(conflict).getByRole('button', { name: 'Resolve' })).toHaveClass('border-amber-60', 'bg-amber-10', 'text-amber');

    const look = row(LOOK.fileName);
    expect(look).toHaveTextContent('Needs a look · Can’t detect the vehicle: 2 folders inside. Pick one to continue.');
    expect(within(look).getByRole('button', { name: 'Pick vehicle' })).toHaveAttribute('aria-haspopup', 'menu');

    const installing = row(INSTALLING.fileName);
    expect(within(installing).getByRole('progressbar', { name: `Installing ${INSTALLING.fileName}` })).toHaveAttribute('aria-valuenow', '0');
    expect(within(installing).queryByRole('button')).not.toBeInTheDocument();

    const done = row(DONE.fileName);
    expect(done).toHaveTextContent('Installed · T-34-85 · Now in My Hangar');
    expect(within(done).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();

    const error = row(ERROR.fileName);
    expect(error).toHaveTextContent(`Error · ${ERROR.error}`);
    expect(within(error).getByText('Error')).toHaveClass('text-danger');

    expect(row(ANALYZING.fileName)).toHaveTextContent('Analyzing…');

    // × on every row that isn't installing.
    for (const item of ALL.filter((i) => i.status !== 'installing')) {
      expect(within(row(item.fileName)).getByRole('button', { name: `Remove ${item.fileName} from the queue` })).toBeInTheDocument();
    }
  });

  it('explains the states and hides the watched path until asked', async () => {
    const user = userEvent.setup();
    renderQueue([]);
    expect(screen.getByText('Queue is empty.')).toBeInTheDocument();
    const legend = screen.getByRole('region', { name: 'What the states mean' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Ready — vehicle detected, files look good.',
      'Conflict — a skin with the same folder is installed.',
      'Needs a look — can’t tell which vehicle it’s for.',
      'Installed — it’s in My Hangar and in the game.',
      'Error — it can’t be installed; the row says why.',
    ]);

    const path = screen.getByText('C:\\Users\\me\\Downloads');
    expect(path).not.toBeVisible();
    const show = screen.getByRole('button', { name: 'Show folder' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await user.click(show);
    expect(path).toBeVisible();
    expect(path).toHaveAttribute('data-selectable');
    expect(screen.getByRole('button', { name: 'Hide folder' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('removes a row here and in the backend, moving focus to the next row', async () => {
    const user = userEvent.setup();
    renderQueue([ERROR, DONE]);
    await user.click(screen.getByRole('button', { name: `Remove ${ERROR.fileName} from the queue` }));
    expect(screen.queryByText(ERROR.fileName)).not.toBeInTheDocument();
    expect(calls('remove_queue_item')).toEqual([{ queueId: ERROR.id }]);
    expect(screen.getByRole('button', { name: `Remove ${DONE.fileName} from the queue` })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Clear installed' }));
    expect(screen.getByText('Queue is empty.')).toBeInTheDocument();
    expect(calls('remove_queue_item')).toEqual([{ queueId: ERROR.id }, { queueId: DONE.id }]);
  });
});

describe('Install queue — adding', () => {
  it('browses for archives or a folder and analyses what was picked', async () => {
    const user = userEvent.setup();
    renderQueue([]);
    expect(screen.getByText('ZIP, RAR and 7z unpacking arrives in a later update. Skin folders install now.')).toBeInTheDocument();

    analyses['D:\\Skins\\Tiger winter'] = q('q-folder', 'Tiger winter', { vehicle: TIGER, files: files(2), textureCount: 1, blkOk: true });
    backend.open.mockResolvedValueOnce('D:\\Skins\\Tiger winter');
    await user.click(screen.getByRole('button', { name: 'Choose a skin folder' }));
    expect(backend.open).toHaveBeenLastCalledWith({ directory: true, title: 'Choose a skin folder' });
    await waitFor(() => expect(row('Tiger winter')).toHaveTextContent('Ready · Tiger II (H) · 2 files · 1 texture · skin.blk ok'));

    backend.open.mockResolvedValueOnce(null);
    await user.click(screen.getByRole('button', { name: /Drop ZIP, RAR or 7z archives anywhere in the window/ }));
    expect(backend.open).toHaveBeenLastCalledWith({
      multiple: true,
      title: 'Add skin archives',
      filters: [{ name: 'Skin archives', extensions: ['zip', 'rar', '7z'] }],
    });
    expect(calls('analyze_archive')).toEqual([{ path: 'D:\\Skins\\Tiger winter' }]);
  });

  it('shows an unsupported archive with the backend message, announces it and lets it be removed', async () => {
    const user = userEvent.setup();
    renderQueue([]);
    const unsupported = q('q-7z', 'mig29_desert.7z', { status: 'error', error: '7z archives can be unpacked once their library is approved.' });
    analyses['C:\\Downloads\\mig29_desert.7z'] = unsupported;
    backend.open.mockResolvedValueOnce(['C:\\Downloads\\mig29_desert.7z']);
    await user.click(screen.getByRole('button', { name: /Drop ZIP, RAR or 7z archives/ }));

    await waitFor(() => expect(row('mig29_desert.7z')).toHaveTextContent(`Error · ${unsupported.error}`));
    expect(screen.getByRole('status')).toHaveTextContent(`mig29_desert.7z can’t be installed. ${unsupported.error}`);
    await user.click(screen.getByRole('button', { name: 'Remove mig29_desert.7z from the queue' }));
    expect(screen.queryByText('mig29_desert.7z')).not.toBeInTheDocument();
    expect(calls('remove_queue_item')).toEqual([{ queueId: 'q-7z' }]);
    // Nothing left: focus goes back to the drop zone.
    expect(screen.getByRole('button', { name: /Drop ZIP, RAR or 7z archives/ })).toHaveFocus();
  });
});

describe('Install queue — installing', () => {
  it('follows progress events on the row; done refreshes the hangar and toasts', async () => {
    const user = userEvent.setup();
    renderQueue([READY]);
    await waitFor(() => expect(backend.listeners.has(EVENTS.installProgress)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(calls('install_from_archive')).toEqual([{ queueId: READY.id }]);

    const bar = within(row(READY.fileName)).getByRole('progressbar');
    expect(row(READY.fileName)).toHaveTextContent('Extracting 0%');
    emitProgress({ installId: 'i-q-ready', queueId: READY.id, step: 'extract', pct: 56 });
    expect(bar).toHaveAttribute('aria-valuenow', '56');
    expect(row(READY.fileName)).toHaveTextContent('Extracting 56%');
    expect(row(READY.fileName)).toHaveTextContent('Verify · Done');
    emitProgress({ installId: 'i-q-ready', queueId: READY.id, step: 'verify', pct: 80 });
    expect(row(READY.fileName)).toHaveTextContent('ExtractVerifying 80%Done');

    const hangarFetches = calls('get_hangar').length;
    emitProgress({ installId: 'i-q-ready', queueId: READY.id, step: 'done', pct: 100, skinId: 's-new' });
    expect(row(READY.fileName)).toHaveTextContent('Installed · Tiger II (H) · Now in My Hangar');
    expect(within(toasts()).getByText('Installed “Tiger ambush winter”')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`${READY.fileName}: installed`);
    await waitFor(() => expect(calls('get_hangar').length).toBeGreaterThan(hangarFetches));
  });

  it('marks a failed install as an error with its message', async () => {
    const user = userEvent.setup();
    renderQueue([READY]);
    await waitFor(() => expect(backend.listeners.has(EVENTS.installProgress)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Install' }));
    emitProgress({ installId: 'i-q-ready', queueId: READY.id, step: 'error', pct: 30, message: 'UserSkins is read-only' });
    expect(row(READY.fileName)).toHaveTextContent('Error · Tiger II (H) · UserSkins is read-only');
    expect(screen.getByRole('status')).toHaveTextContent('can’t be installed. UserSkins is read-only');
  });

  it('installs every ready item one after the other with one toast', async () => {
    const user = userEvent.setup();
    renderQueue([READY, CONFLICT, READY_2]);
    await waitFor(() => expect(backend.listeners.has(EVENTS.installProgress)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Install 2 ready' }));
    await waitFor(() => expect(calls('install_from_archive')).toEqual([{ queueId: READY.id }]));
    const batch = screen.getByRole('button', { name: 'Install 2 ready' });
    expect(batch).toHaveAttribute('aria-disabled', 'true');

    emitProgress({ installId: 'i-q-ready', queueId: READY.id, step: 'done', pct: 100 });
    await waitFor(() => expect(calls('install_from_archive')).toEqual([{ queueId: READY.id }, { queueId: READY_2.id }]));
    emitProgress({ installId: 'i-q-ready2', queueId: READY_2.id, step: 'done', pct: 100 });

    await within(toasts()).findByText('Installed 2 skins');
    expect(within(toasts()).queryByText(/Installed “/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install \d ready/ })).not.toBeInTheDocument();
    // The Conflict row was left alone.
    expect(row(CONFLICT.fileName)).toHaveTextContent('Conflict');
  });

  it('installs a needs-a-look item with the picked vehicle', async () => {
    const user = userEvent.setup();
    renderQueue([LOOK]);
    await user.click(screen.getByRole('button', { name: 'Pick vehicle' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Su-27su_27', 'Su-27SMsu_27sm']);
    // The code brightens to ink-3 on the highlighted item (bg-4 on hover / keyboard focus; ink-4 is 4.25:1 there).
    expect(within(menu).getByText('su_27sm')).toHaveClass('text-ink-4', 'group-hover:text-ink-3', 'group-focus-visible:text-ink-3');
    expect(within(menu).getAllByRole('menuitem')[1]).toHaveClass('group');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(calls('install_from_archive')).toEqual([{ queueId: LOOK.id, vehicleCode: 'su_27sm' }]);
    expect(row(LOOK.fileName)).toHaveTextContent('Installing · Su-27SM');
    // The trigger went away with the status: focus lands on the row, not on <body>.
    await waitFor(() => expect(row(LOOK.fileName)).toHaveFocus());
  });
});

describe('Install queue — conflicts', () => {
  it('opens the dialog from Resolve: focus on Replace, Tab stays inside, Escape cancels only the dialog', async () => {
    const user = userEvent.setup();
    renderQueue([CONFLICT]);
    const resolve = screen.getByRole('button', { name: 'Resolve' });
    await user.click(resolve);

    const dialog = screen.getByRole('dialog', { name: 'This skin is already installed' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('leopard_flecktarn_v2.zip uses the same folder as “Bundeswehr Flecktarn” on Leopard 2A4.');
    expect(dialog).toHaveClass('w-[520px]', 'rounded-dialog', 'border-line-4', 'shadow-dialog', 'px-6', 'py-5.5');
    const replace = within(dialog).getByRole('button', { name: /^Replace, keep a backup/ });
    const copy = within(dialog).getByRole('button', { name: /^Install as a copy/ });
    const skip = within(dialog).getByRole('button', { name: /^Skip/ });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(replace).toHaveFocus();
    expect(replace).toHaveAttribute('aria-keyshortcuts', 'Enter');
    expect(replace).toHaveClass('border-amber-60', 'bg-amber-10', 'hover:bg-amber-18');
    expect(within(dialog).getByText('Change the default in Settings → Conflicts')).toBeInTheDocument();

    await user.tab();
    expect(copy).toHaveFocus();
    await user.tab();
    expect(skip).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(replace).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();

    // Section keys don't switch screens under the modal; Escape doesn't reach the window.
    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);
    await user.keyboard('2{Escape}');
    window.removeEventListener('keydown', windowKeys);
    expect(windowKeys).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(resolve).toHaveFocus();
    expect(calls('install_from_archive')).toEqual([]);
  });

  it('Enter replaces; the toast offers Undo, which restores the previous version', async () => {
    const user = userEvent.setup();
    renderQueue([CONFLICT]);
    await waitFor(() => expect(backend.listeners.has(EVENTS.installProgress)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await user.keyboard('{Enter}');
    expect(calls('install_from_archive')).toEqual([{ queueId: CONFLICT.id, conflict: 'replace' }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(row(CONFLICT.fileName)).getByRole('progressbar')).toBeInTheDocument();
    // Resolve is gone with the dialog's opener: focus falls back to the row.
    expect(row(CONFLICT.fileName)).toHaveFocus();

    emitProgress({ installId: 'i-q-conflict', queueId: CONFLICT.id, step: 'done', pct: 100, skinId: 's-new', backupId: 'b-1' });
    const message = within(toasts()).getByText('Replaced “Bundeswehr Flecktarn” · backup kept');
    await user.click(within(message.parentElement as HTMLElement).getByRole('button', { name: 'Undo' }));
    expect(calls('undo_replace')).toEqual([{ skinId: 's-new', backupId: 'b-1' }]);
    await within(toasts()).findByText('Restored the previous version');
    expect(row(CONFLICT.fileName)).toHaveTextContent('Conflict · Leopard 2A4');
  });

  it('installs as a copy or skips from the dialog', async () => {
    const user = userEvent.setup();
    const other = { ...CONFLICT, id: 'q-conflict2', fileName: 'leopard_flecktarn_v3.zip' };
    renderQueue([CONFLICT, other]);
    await waitFor(() => expect(backend.listeners.has(EVENTS.installProgress)).toBe(true));

    await user.click(within(row(CONFLICT.fileName)).getByRole('button', { name: 'Resolve' }));
    await user.click(screen.getByRole('button', { name: /^Install as a copy/ }));
    expect(calls('install_from_archive')).toEqual([{ queueId: CONFLICT.id, conflict: 'copy' }]);
    emitProgress({ installId: 'i-q-conflict', queueId: CONFLICT.id, step: 'done', pct: 100, skinId: 's-copy' });
    expect(within(toasts()).getByText('Installed as a copy')).toBeInTheDocument();

    await user.click(within(row(other.fileName)).getByRole('button', { name: 'Resolve' }));
    await user.click(screen.getByRole('button', { name: /^Skip/ }));
    expect(calls('install_from_archive')).toContainEqual({ queueId: other.id, conflict: 'skip' });
    await within(toasts()).findByText('Skipped. Nothing changed.');
    expect(screen.queryByText(other.fileName)).not.toBeInTheDocument();
  });

  it('applies the Settings policy directly instead of asking (replace stays undoable)', async () => {
    const user = userEvent.setup();
    renderQueue([CONFLICT], { conflictPolicy: 'replace' });
    await waitFor(() => expect(backend.listeners.has(EVENTS.installProgress)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('install_from_archive')).toEqual([{ queueId: CONFLICT.id, conflict: 'replace' }]);
    emitProgress({ installId: 'i-q-conflict', queueId: CONFLICT.id, step: 'done', pct: 100, skinId: 's-new', backupId: 'b-2' });
    const message = within(toasts()).getByText('Replaced “Bundeswehr Flecktarn” · backup kept');
    expect(within(message.parentElement as HTMLElement).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('asks when a single install turns out to conflict, and Cancel returns focus to Resolve', async () => {
    const user = userEvent.setup();
    installReply = () => {
      throw { code: 'conflict', message: 'Same folder' };
    };
    renderQueue([READY]);
    await user.click(screen.getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: 'This skin is already installed' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Replace/ })).toHaveFocus());
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(row(READY.fileName)).getByRole('button', { name: 'Resolve' })).toHaveFocus();
  });

  it('returns focus to Resolve, not the row, when the refusal arrives after focus moved to the row', async () => {
    const user = userEvent.setup();
    installReply = async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw { code: 'conflict', message: 'Same folder' };
    };
    renderQueue([READY]);
    await user.click(screen.getByRole('button', { name: 'Install' }));
    // The Install button vanished while the row installs: focus rescued to the row first.
    await waitFor(() => expect(row(READY.fileName)).toHaveFocus());
    const dialog = await screen.findByRole('dialog', { name: 'This skin is already installed' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(row(READY.fileName)).getByRole('button', { name: 'Resolve' })).toHaveFocus();
  });
});

describe('Install queue — watch folder', () => {
  it('turns the watcher on and off, and changes the folder', async () => {
    const user = userEvent.setup();
    renderQueue([]);
    const toggle = screen.getByRole('switch', { name: 'Watch Downloads folder' });
    expect(toggle).toHaveAccessibleDescription('New skin archives install automatically.');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(calls('watch_folder')).toEqual([{ enabled: true }]);

    backend.open.mockResolvedValueOnce('D:\\Skins inbox');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(backend.open).toHaveBeenLastCalledWith({ directory: true, title: 'Choose the folder to watch', defaultPath: 'C:\\Users\\me\\Downloads' });
    await waitFor(() => expect(calls('watch_folder')).toEqual([{ enabled: true }, { path: 'D:\\Skins inbox', enabled: true }]));
    expect(await screen.findByText('D:\\Skins inbox')).not.toBeVisible();
  });

  it('flips back and says why when the watcher can’t start', async () => {
    const user = userEvent.setup();
    watchReply = () => {
      throw { code: 'notFound', message: 'The Downloads folder doesn’t exist' };
    };
    renderQueue([]);
    const toggle = screen.getByRole('switch', { name: 'Watch Downloads folder' });
    await user.click(toggle);
    await within(toasts()).findByText('The Downloads folder doesn’t exist');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('says why in Italian: the backend’s known message translated', async () => {
    const user = userEvent.setup();
    watchReply = () => {
      throw { code: 'invalidInput', message: "The watched folder can't be found" };
    };
    await i18n.changeLanguage('it');
    try {
      renderQueue([]);
      await user.click(screen.getByRole('switch', { name: 'Controlla la cartella Download' }));
      await within(screen.getByRole('region', { name: 'Notifiche' })).findByText('Impossibile trovare la cartella controllata');
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });
});

describe('Install queue — accessibility', () => {
  it('has no serious axe violations with every row status', async () => {
    const { container } = renderQueue(ALL);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('has no serious axe violations with the conflict dialog open', async () => {
    const user = userEvent.setup();
    const { container } = renderQueue([CONFLICT, READY]);
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });
});
