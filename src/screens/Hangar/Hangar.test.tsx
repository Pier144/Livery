import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/chrome/Toaster';
import i18n from '@/i18n';
import { createQueryClient } from '@/queries/client';
import { COLLECTIONS_KEY } from '@/queries/collections';
import { HANGAR_KEY } from '@/queries/hangar';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { Collection, CollectionsState, HangarSkin, Vehicle } from '@/types';
import { Hangar } from '../Hangar';
import { mockLayout } from './testLayout';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  open: vi.fn<(options: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (options: unknown) => backend.open(options),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const vehicle = (code: string, name: string, nation: Vehicle['nation'], type: Vehicle['type']): Vehicle => ({
  code,
  name,
  nation,
  type,
  class: '',
});
const TIGER = vehicle('germ_pzkpfw_VI_ausf_e_tiger', 'Tiger H1', 'GER', 'ground');
const T34 = vehicle('ussr_t_34_85', 'T-34-85', 'USSR', 'ground');
const F4 = vehicle('f_4e', 'F-4E Phantom II', 'USA', 'air');

function skin(id: string, name: string, v: Vehicle, extra: Partial<HangarSkin> = {}): HangarSkin {
  return { id, folder: name, name, vehicle: v, origin: 'imported', sizeBytes: 10 * MB, active: true, installedAt: '2026-09-19T10:00:00Z', ...extra };
}

const SKINS: HangarSkin[] = [
  skin('h1', 'Winter whitewash', T34, { attention: [{ kind: 'missingTexture', message: 'turret_c.dds is missing', file: 'turret_c.dds' }] }),
  skin('h2', 'Factory olive', T34, { origin: 'mine', active: false }),
  skin('h3', 'Ambush', TIGER, { origin: 'wtlive', author: { id: 'a1', name: 'Kessler_Wolf', url: 'https://example.invalid' } }),
  skin('h4', 'Desert tan', TIGER, {
    active: false,
    attention: [
      { kind: 'unknownBlkBlock', message: 'x', file: 'germ_pzkpfw_VI_ausf_e_tiger.blk' },
      { kind: 'missingTexture', message: 'y', file: 'hull_n.dds' },
    ],
  }),
  skin('h5', 'SEA Camo', F4, { origin: 'wtlive' }),
];

const COLLECTIONS: Collection[] = [{ id: 'c1', name: 'Desert ops', skinIds: [], createdAt: '2026-09-19T10:00:00Z' }];

/** In-memory backend with the command semantics My Hangar relies on. */
interface FakeState {
  skins: HangarSkin[];
  collections: Collection[];
  backups: Map<string, HangarSkin>;
  /** What `scan_user_skins` returns (defaults to the index). */
  scan?: HangarSkin[];
}
let state: FakeState;

function installBackend() {
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    const ids = (args.ids ?? []) as string[];
    switch (cmd) {
      case 'get_hangar':
        return state.skins;
      case 'set_skin_active':
        state.skins = state.skins.map((s) => (ids.includes(s.id) ? { ...s, active: args.active as boolean } : s));
        return state.skins;
      case 'delete_skins': {
        const backupIds = state.skins.filter((s) => ids.includes(s.id)).map((s) => {
          state.backups.set(`b-${s.id}`, s);
          return `b-${s.id}`;
        });
        state.skins = state.skins.filter((s) => !ids.includes(s.id));
        return { backupIds };
      }
      case 'restore_backups': {
        const restored = (args.backupIds as string[]).flatMap((b) => state.backups.get(b) ?? []);
        state.skins = [...state.skins, ...restored];
        return restored;
      }
      case 'collections_list':
        return { collections: state.collections } satisfies CollectionsState;
      case 'collections_set_skins': {
        const c = state.collections.find((x) => x.id === args.id);
        if (!c) throw { code: 'notFound', message: 'No such collection' };
        return { ...c, skinIds: [...c.skinIds, ...(args.add as string[])] };
      }
      case 'export_skins':
        return { exported: ids.length, dest: args.dest };
      case 'scan_user_skins':
        return state.scan ?? state.skins;
      default:
        throw { code: 'noBackend', message: `unexpected ${cmd}` };
    }
  });
}

function renderHangar(skins: HangarSkin[] = SKINS, collections: Collection[] = COLLECTIONS) {
  state = { skins, collections, backups: new Map() };
  const client = createQueryClient();
  client.setQueryData(HANGAR_KEY, skins);
  client.setQueryData(COLLECTIONS_KEY, { collections });
  return renderWithProviders(
    <>
      <Hangar />
      <Toaster />
    </>,
    { client },
  );
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const card = (name: string) => screen.getByRole('button', { name, pressed: false }) as HTMLElement;
const cardOf = (name: string) => screen.getByRole('button', { name }).parentElement as HTMLElement;
const cardNames = () =>
  screen
    .queryAllByRole('button', { pressed: undefined })
    .filter((el) => el.hasAttribute('aria-pressed') && el.hasAttribute('title'))
    .map((el) => el.getAttribute('aria-label'));
const bar = () => screen.getByRole('toolbar', { name: 'Selected skins' });
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);

let restoreLayout: () => void;

beforeEach(() => {
  resetStores();
  backend.call.mockReset();
  backend.open.mockReset();
  installBackend();
  restoreLayout = mockLayout();
});

afterEach(async () => {
  restoreLayout();
  await act(() => i18n.changeLanguage('en'));
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('My Hangar', () => {
  it('shows totals, the attention count and one heading per vehicle, sorted by name', () => {
    renderHangar();
    expect(screen.getByRole('heading', { level: 1, name: 'My Hangar' })).toBeInTheDocument();
    expect(screen.getByText('5 skins · 3 active · 50 MB on disk')).toBeInTheDocument();
    expect(screen.getByText('2 need attention')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['F-4E Phantom II', 'T-34-85', 'Tiger H1']);
    expect(screen.getByText('germ_pzkpfw_VI_ausf_e_tiger')).toBeInTheDocument();
    expect(cardNames()).toEqual(['SEA Camo', 'Factory olive', 'Winter whitewash', 'Ambush', 'Desert tan']);
  });

  it('shows skeleton cards while the index loads', () => {
    backend.call.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Hangar />);
    expect(screen.getByRole('status', { busy: true })).toHaveTextContent('Loading');
  });

  it('shows the empty state and goes to Explore', async () => {
    const user = userEvent.setup();
    renderHangar([]);
    expect(screen.getByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Browse WT Live' }));
    expect(useUi.getState().screen).toBe('explore');
  });

  it('localizes attention messages and appends +N', async () => {
    renderHangar();
    expect(within(cardOf('Winter whitewash')).getByText('turret_c.dds is missing')).toBeInTheDocument();
    expect(within(cardOf('Winter whitewash')).getByText('NEEDS ATTENTION')).toBeInTheDocument();
    expect(within(cardOf('Desert tan')).getByText('germ_pzkpfw_VI_ausf_e_tiger.blk has an unknown block +1')).toBeInTheDocument();
    expect(within(cardOf('Ambush')).queryByText('NEEDS ATTENTION')).not.toBeInTheDocument();
    await act(() => i18n.changeLanguage('it'));
    expect(within(cardOf('Winter whitewash')).getByText('manca turret_c.dds')).toBeInTheDocument();
    expect(within(cardOf('Winter whitewash')).getByText('DA CONTROLLARE')).toBeInTheDocument();
    expect(screen.getByText('2 da controllare')).toBeInTheDocument();
  });

  describe('filters', () => {
    it('searches name, vehicle name and code instantly', async () => {
      const user = userEvent.setup();
      renderHangar();
      const search = screen.getByRole('searchbox', { name: 'Search My Hangar' });
      await user.type(search, 'tiger');
      expect(cardNames()).toEqual(['Ambush', 'Desert tan']);
      await user.clear(search);
      await user.type(search, 'F_4E');
      expect(cardNames()).toEqual(['SEA Camo']);
      await user.clear(search);
      await user.type(search, 'olive');
      expect(cardNames()).toEqual(['Factory olive']);
    });

    it('chips offer only values in the hangar and combine with the search', async () => {
      const user = userEvent.setup();
      renderHangar();
      await user.click(screen.getByRole('button', { name: 'Nation' }));
      const menu = screen.getByRole('menu', { name: 'Nation' });
      expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['All nations', 'USA', 'Germany', 'USSR']);
      await user.click(within(menu).getByRole('menuitemradio', { name: 'USSR' }));
      expect(cardNames()).toEqual(['Factory olive', 'Winter whitewash']);
      // The chip now shows the choice (amber) and keeps its name for screen readers.
      expect(screen.getByRole('button', { name: 'Nation: USSR' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Origin' }));
      await user.click(screen.getByRole('menuitemradio', { name: 'Mine' }));
      expect(cardNames()).toEqual(['Factory olive']);

      await user.type(screen.getByRole('searchbox'), 'winter');
      expect(screen.getByRole('heading', { name: 'No skins match' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(cardNames()).toHaveLength(5);
      expect(screen.getByRole('searchbox')).toHaveValue('');
    });

    it('filters by type', async () => {
      const user = userEvent.setup();
      renderHangar();
      await user.click(screen.getByRole('button', { name: 'Type' }));
      expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['All types', 'Ground', 'Air']);
      await user.click(screen.getByRole('menuitemradio', { name: 'Air' }));
      expect(cardNames()).toEqual(['SEA Camo']);
    });
  });

  it('switches to the list view and remembers it', async () => {
    const user = userEvent.setup();
    renderHangar();
    await user.click(screen.getByRole('radio', { name: 'List view' }));
    expect(screen.getByRole('radio', { name: 'List view' })).toBeChecked();
    // List rows show the author column: WT Live author, "you" for your own, "—" otherwise.
    expect(within(cardOf('Ambush')).getByText('Kessler_Wolf')).toBeInTheDocument();
    expect(within(cardOf('Factory olive')).getByText('you')).toBeInTheDocument();
    expect(within(cardOf('SEA Camo')).getByText('—')).toBeInTheDocument();
    expect(within(cardOf('Winter whitewash')).getByText('turret_c.dds is missing')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('livery.hangar') ?? '{}').state).toEqual({ view: 'list' });
  });

  describe('WT Live skins open their Skin detail', () => {
    // Ambush and SEA Camo came from WT Live (sourceId); the others are local.
    const SOURCES: Record<string, string> = { h3: 'wt-ambush', h5: 'wt-sea' };
    const FROM_WT_LIVE = SKINS.map((s) => (SOURCES[s.id] ? { ...s, sourceId: SOURCES[s.id] } : s));
    const backToHangar = () => act(() => useUi.getState().go('hangar'));

    it('click and Enter open the page; Space, Ctrl+click, the checkbox and Shift still select', async () => {
      const user = userEvent.setup();
      renderHangar(FROM_WT_LIVE);
      backToHangar();

      await user.click(card('Ambush'));
      expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 'wt-ambush' });
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      backToHangar();

      card('SEA Camo').focus();
      await user.keyboard('{Enter}');
      expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 'wt-sea' });
      backToHangar();

      // Space selects instead of opening.
      card('SEA Camo').focus();
      await user.keyboard(' ');
      expect(useUi.getState().screen).toBe('hangar');
      expect(screen.getByRole('button', { name: 'SEA Camo' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(bar()).getByText('1 skin selected')).toBeInTheDocument();

      // Ctrl+click and the checkbox select too.
      await user.keyboard('{Control>}');
      await user.click(card('Ambush'));
      await user.keyboard('{/Control}');
      expect(useUi.getState().screen).toBe('hangar');
      expect(within(bar()).getByText('2 skins selected')).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: 'Select Ambush' }));
      expect(screen.getByRole('button', { name: 'Ambush' })).toHaveAttribute('aria-pressed', 'false');

      // Shift+click extends the range from the last toggled skin (Ambush → Desert tan).
      await user.keyboard('{Shift>}');
      await user.click(screen.getByRole('button', { name: 'Desert tan' }));
      await user.keyboard('{/Shift}');
      expect(useUi.getState().screen).toBe('hangar');
      expect(within(bar()).getByText('3 skins selected')).toBeInTheDocument();
    });

    it('local skins keep selecting on click and Enter', async () => {
      const user = userEvent.setup();
      renderHangar(FROM_WT_LIVE);
      backToHangar();
      await user.click(card('Factory olive'));
      card('Winter whitewash').focus();
      await user.keyboard('{Enter}');
      expect(useUi.getState().screen).toBe('hangar');
      expect(within(bar()).getByText('2 skins selected')).toBeInTheDocument();
    });

    it('tells screen-reader users what Enter does on each kind of skin', () => {
      renderHangar(FROM_WT_LIVE);
      expect(card('Ambush')).toHaveAccessibleDescription('Press Enter to open the skin page, Space to select it.');
      expect(card('Factory olive')).toHaveAccessibleDescription('Press Enter or Space to select it. Local skins have no skin page.');
    });

    it('list rows open the page the same way', async () => {
      const user = userEvent.setup();
      renderHangar(FROM_WT_LIVE);
      backToHangar();
      await user.click(screen.getByRole('radio', { name: 'List view' }));
      await user.click(card('Ambush'));
      expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 'wt-ambush' });
      backToHangar();
      expect(card('SEA Camo')).toHaveAccessibleDescription('Press Enter to open the skin page, Space to select it.');
      await user.click(card('Winter whitewash'));
      expect(within(bar()).getByText('1 skin selected')).toBeInTheDocument();
    });

    it('stays axe-clean with the hints', async () => {
      const { container } = renderHangar(FROM_WT_LIVE);
      expect(await seriousViolations(container)).toEqual([]);
    });
  });

  describe('selection', () => {
    it('selects local skins with the checkbox, the card (click, Enter, Space) and Shift ranges', async () => {
      const user = userEvent.setup();
      renderHangar();
      await user.click(screen.getByRole('checkbox', { name: 'Select Ambush' }));
      expect(screen.getByRole('button', { name: 'Ambush' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('checkbox', { name: 'Select Ambush' })).toBeChecked();
      expect(within(bar()).getByText('1 skin selected')).toBeInTheDocument();

      await user.click(card('SEA Camo'));
      expect(within(bar()).getByText('2 skins selected')).toBeInTheDocument();

      card('Factory olive').focus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('button', { name: 'Factory olive' })).toHaveAttribute('aria-pressed', 'true');
      await user.keyboard(' ');
      expect(screen.getByRole('button', { name: 'Factory olive' })).toHaveAttribute('aria-pressed', 'false');
      expect(within(bar()).getByText('2 skins selected')).toBeInTheDocument();

      // Shift+click selects from the last toggled skin in on-screen order.
      await user.click(card('Factory olive'));
      await user.keyboard('{Shift>}');
      await user.click(card('Desert tan'));
      await user.keyboard('{/Shift}');
      expect(within(bar()).getByText('5 skins selected')).toBeInTheDocument();
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('5 skins selected');
    });

    it('"Select all" selects what the filters show, then becomes "Clear selection"', async () => {
      const user = userEvent.setup();
      renderHangar();
      await user.type(screen.getByRole('searchbox'), 'tiger');
      await user.click(screen.getByRole('button', { name: 'Select all' }));
      expect(within(bar()).getByText('2 skins selected')).toBeInTheDocument();
      // The toolbar button (the bar's × has the same name and job).
      const clearButton = screen.getAllByRole('button', { name: 'Clear selection' }).find((b) => !bar().contains(b));
      await user.click(clearButton as HTMLElement);
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument();
    });

    it('bulk actions only count the skins the filters show', async () => {
      const user = userEvent.setup();
      renderHangar();
      await user.click(screen.getByRole('button', { name: 'Select all' }));
      expect(within(bar()).getByText('5 skins selected')).toBeInTheDocument();
      await user.type(screen.getByRole('searchbox'), 'desert');
      expect(within(bar()).getByText('1 skin selected')).toBeInTheDocument();
    });

    it('Escape in the bar clears the selection and returns focus to the list', async () => {
      const user = userEvent.setup();
      renderHangar();
      await user.click(card('Ambush'));
      within(bar()).getByRole('button', { name: 'Activate' }).focus();
      await user.keyboard('{ArrowRight}');
      expect(within(bar()).getByRole('button', { name: 'Deactivate' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ambush' })).toHaveFocus();
    });
  });

  it('toggles a skin active (optimistically) through set_skin_active', async () => {
    const user = userEvent.setup();
    renderHangar();
    const toggle = within(cardOf('Ambush')).getByRole('button', { name: 'Active' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);
    expect(calls('set_skin_active')).toEqual([{ ids: ['h3'], active: false }]);
    await waitFor(() => expect(within(cardOf('Ambush')).getByRole('button', { name: 'Inactive' })).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByText('5 skins · 2 active · 50 MB on disk')).toBeInTheDocument();
    // The toggle doesn't select the card.
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('reverts the toggle and toasts when the backend refuses', async () => {
    const user = userEvent.setup();
    renderHangar();
    backend.call.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_skin_active') throw { code: 'conflict', message: 'A skin folder with that name already exists' };
      return state.skins;
    });
    await user.click(within(cardOf('Ambush')).getByRole('button', { name: 'Active' }));
    await waitFor(() => expect(toastTexts()).toEqual(['A skin folder with that name already exists']));
    expect(within(cardOf('Ambush')).getByRole('button', { name: 'Active' })).toBeInTheDocument();
  });

  it('bulk Activate / Deactivate update every selected skin and clear the selection', async () => {
    const user = userEvent.setup();
    renderHangar();
    await user.click(card('Factory olive'));
    await user.click(card('Desert tan'));
    await user.click(within(bar()).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(toastTexts()).toContain('2 skins activated'));
    expect(calls('set_skin_active')).toEqual([{ ids: ['h2', 'h4'], active: true }]);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByText('5 skins · 5 active · 50 MB on disk')).toBeInTheDocument();
  });

  it('bulk Delete removes the skins, toasts with Undo, and Undo restores the backups', async () => {
    const user = userEvent.setup();
    renderHangar();
    await user.click(card('Ambush'));
    await user.click(card('SEA Camo'));
    await user.click(within(bar()).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('Deleted 2 skins')).toBeInTheDocument());
    expect(calls('delete_skins')).toEqual([{ ids: ['h5', 'h3'] }]);
    expect(screen.queryByRole('button', { name: 'Ambush' })).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByText('3 skins · 1 active · 30 MB on disk')).toBeInTheDocument();
    // The last focused card was deleted: focus lands on "Select all", not on the page body.
    expect(screen.getByRole('button', { name: 'Select all' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    // Exactly the backups the delete returned.
    expect(calls('restore_backups')).toEqual([{ backupIds: ['b-h3', 'b-h5'] }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ambush' })).toBeInTheDocument());
    expect(screen.getByText('Restored 2 skins')).toBeInTheDocument();
  });

  it('still reports a Delete whose folders were already gone (no backup, no Undo)', async () => {
    const user = userEvent.setup();
    renderHangar();
    const fallback = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd, args) => {
      if (cmd !== 'delete_skins') return fallback(cmd, args);
      state.skins = state.skins.filter((s) => s.id !== 'h3');
      return { backupIds: [] };
    });
    await user.click(card('Ambush'));
    await user.click(within(bar()).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastTexts()).toContain('Deleted 1 skin'));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('moves the selection to a collection', async () => {
    const user = userEvent.setup();
    renderHangar();
    await user.click(card('Ambush'));
    await user.click(card('Desert tan'));
    await user.click(within(bar()).getByRole('button', { name: 'Move to collection' }));
    const menu = screen.getByRole('menu', { name: 'Move to collection' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Desert ops' }));
    await waitFor(() => expect(toastTexts()).toContain('2 skins moved to “Desert ops”'));
    expect(calls('collections_set_skins')).toEqual([{ id: 'c1', add: ['h3', 'h4'], remove: [] }]);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('offers a disabled placeholder when there are no collections', async () => {
    const user = userEvent.setup();
    renderHangar(SKINS, []);
    await user.click(card('Ambush'));
    await user.click(within(bar()).getByRole('button', { name: 'Move to collection' }));
    const item = screen.getByRole('menuitem', { name: 'No collections yet' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    await user.click(item);
    expect(calls('collections_set_skins')).toEqual([]);
  });

  it('exports to a picked folder and names only the folder in the toast', async () => {
    const user = userEvent.setup();
    backend.open.mockResolvedValue('C:\\Users\\me\\Desktop\\Skins');
    renderHangar();
    await user.click(card('Ambush'));
    await user.click(card('SEA Camo'));
    await user.click(within(bar()).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toastTexts()).toEqual(['Exported 2 skins to “Skins”']));
    expect(backend.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(calls('export_skins')).toEqual([{ ids: ['h5', 'h3'], dest: 'C:\\Users\\me\\Desktop\\Skins' }]);
    // Export keeps the selection.
    expect(within(bar()).getByText('2 skins selected')).toBeInTheDocument();
  });

  it('does nothing when the folder picker is cancelled', async () => {
    const user = userEvent.setup();
    backend.open.mockResolvedValue(null);
    renderHangar();
    await user.click(card('Ambush'));
    await user.click(within(bar()).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(backend.open).toHaveBeenCalled());
    expect(calls('export_skins')).toEqual([]);
  });

  it('Re-check rescans and reports the outcome', async () => {
    const user = userEvent.setup();
    renderHangar();
    state.scan = SKINS.map((s) => (s.id === 'h1' ? { ...s, attention: undefined } : s));
    await user.click(within(cardOf('Winter whitewash')).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(toastTexts()).toEqual(['“Winter whitewash” looks fine now']));
    expect(calls('scan_user_skins')).toHaveLength(1);

    state.scan = SKINS;
    await user.click(within(cardOf('Desert tan')).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(toastTexts()).toContain('“Desert tan” still needs attention'));
  });

  it('renders a bounded window of cards for 1,000 skins and follows the scroll', () => {
    const many: HangarSkin[] = [];
    for (let v = 0; v < 50; v++) {
      const code = `veh_${String(v).padStart(2, '0')}`;
      for (let i = 0; i < 20; i++) many.push(skin(`${code}-${i}`, `Skin ${String(i).padStart(2, '0')}`, vehicle(code, `Vehicle ${String(v).padStart(2, '0')}`, 'USA', 'ground')));
    }
    const { container } = renderHangar(many);
    expect(screen.getByText('1,000 skins · 1,000 active · 9.8 GB on disk')).toBeInTheDocument();
    const rendered = () => container.querySelectorAll('[data-skin-id]').length;
    expect(rendered()).toBeGreaterThan(0);
    expect(rendered()).toBeLessThanOrEqual(48);
    expect(screen.getByRole('heading', { name: 'Vehicle 00' })).toBeInTheDocument();

    const scroller = screen.getByRole('region', { name: 'Your skins' });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 30_000 });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('heading', { name: 'Vehicle 00' })).not.toBeInTheDocument();
    expect(rendered()).toBeGreaterThan(0);
    expect(rendered()).toBeLessThanOrEqual(48);
  });

  it('re-flows the card lines when the list is resized', () => {
    const resizes: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizes.push(() => callback([], this as unknown as ResizeObserver));
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let width = 1000;
    restoreLayout();
    restoreLayout = mockLayout({ width: () => width });
    try {
      const { container } = renderHangar(Array.from({ length: 8 }, (_, i) => skin(`s${i}`, `Skin ${i}`, F4)));
      const lines = () => [...container.querySelectorAll<HTMLElement>('[data-row-key^="c:"]')].map((el) => el.querySelectorAll('[data-skin-id]').length);
      expect(lines()).toEqual([4, 4]);
      width = 500;
      act(() => resizes.forEach((notify) => notify()));
      expect(lines()).toEqual([2, 2, 2, 2]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the focused card mounted when it scrolls out of the window', () => {
    const many: HangarSkin[] = Array.from({ length: 400 }, (_, i) => skin(`s${i}`, `Skin ${String(i).padStart(3, '0')}`, F4));
    renderHangar(many);
    const first = screen.getByRole('button', { name: 'Skin 000' });
    first.focus();
    const scroller = screen.getByRole('region', { name: 'Your skins' });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 15_000 });
    fireEvent.scroll(scroller);
    // Its line (Skin 000–003, 4 columns) stays; the next line is gone.
    expect(screen.queryByRole('button', { name: 'Skin 004' })).not.toBeInTheDocument();
    expect(cardNames().some((name) => Number(name?.slice(5)) >= 100)).toBe(true);
    expect(first).toBeInTheDocument();
    expect(first).toHaveFocus();
  });

  describe('accessibility', () => {
    it('grid view has no serious axe violations', async () => {
      const { container } = renderHangar();
      expect(await seriousViolations(container)).toEqual([]);
    });

    it('list view has no serious axe violations', async () => {
      const user = userEvent.setup();
      const { container } = renderHangar();
      await user.click(screen.getByRole('radio', { name: 'List view' }));
      expect(await seriousViolations(container)).toEqual([]);
    });

    it('the bulk bar and its menu have no serious axe violations', async () => {
      const user = userEvent.setup();
      const { container } = renderHangar();
      await user.click(card('Ambush'));
      await user.click(within(bar()).getByRole('button', { name: 'Move to collection' }));
      expect(await seriousViolations(container)).toEqual([]);
    });
  });
});
