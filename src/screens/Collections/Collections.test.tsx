import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/chrome/Toaster';
import { createQueryClient } from '@/queries/client';
import { COLLECTIONS_KEY } from '@/queries/collections';
import { HANGAR_KEY } from '@/queries/hangar';
import { resetCollectionsUi, useCollectionsUi } from '@/store/collections';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AppError, Collection, CollectionsState, HangarSkin, Vehicle } from '@/types';
import { Collections } from '../Collections';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

const MB = 1024 * 1024;
const vehicle = (code: string, name: string): Vehicle => ({ code, name, nation: 'GER', type: 'ground', class: 'Heavy tank' });
const TIGER = vehicle('germ_pzkpfw_VI_ausf_e_tiger', 'Tiger H1');
const T34 = vehicle('ussr_t_34_85_d_5t', 'T-34-85 (D-5T)');
const SHERMAN = vehicle('us_m4a3e8_76w_sherman', 'M4A3E8');
const skin = (id: string, name: string, v: Vehicle, mb: number, active = true): HangarSkin => ({
  id,
  folder: name,
  name,
  vehicle: v,
  origin: 'imported',
  sizeBytes: mb * MB,
  active,
  installedAt: '2026-09-19T10:00:00Z',
});
const HANGAR: HangarSkin[] = [
  skin('h1', 'Kursk 1943', TIGER, 40),
  skin('h2', 'Winter whitewash', T34, 20),
  skin('h3', 'Desert tan', TIGER, 10, false),
  skin('h4', 'Normandy', SHERMAN, 30, false),
];
const collection = (id: string, name: string, skinIds: string[], description?: string): Collection => ({
  id,
  name,
  description,
  skinIds,
  createdAt: '2026-09-01T10:00:00Z',
});
const COLLECTIONS: CollectionsState = {
  collections: [
    // "gone" was deleted from the hangar: hidden, and not counted.
    collection('c1', 'Historical only', ['h1', 'h2', 'gone'], 'Period-accurate liveries'),
    collection('c2', 'Screenshots', ['h3', 'h4', 'h1'], 'High-contrast skins'),
    collection('c3', 'Fictional fun', []),
  ],
  activeCollectionId: 'c1',
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory stand-in for the Rust library (collections.rs semantics, trimmed down). */
function fakeBackend(initial: CollectionsState = COLLECTIONS, hangar: HangarSkin[] = HANGAR) {
  const db = { ...clone(initial), hangar: clone(hangar) };
  let nextId = 100;
  const find = (id: unknown) => {
    const c = db.collections.find((x) => x.id === id);
    if (!c) throw { code: 'notFound', message: 'Collection not found' } satisfies AppError;
    return c;
  };
  const handlers: Record<string, (args: Args) => unknown> = {
    collections_list: () => ({ collections: db.collections, activeCollectionId: db.activeCollectionId }),
    get_hangar: () => db.hangar,
    collections_create: ({ name }) => {
      const c = collection(`c${nextId++}`, String(name), []);
      db.collections.push(c);
      return c;
    },
    collections_update: ({ id, name, description }) => {
      const c = find(id);
      if (typeof name === 'string') c.name = name;
      if (typeof description === 'string') c.description = description || undefined;
      return c;
    },
    collections_delete: ({ id }) => {
      db.collections = db.collections.filter((c) => c.id !== id);
      if (db.activeCollectionId === id) db.activeCollectionId = undefined;
      return { collections: db.collections, activeCollectionId: db.activeCollectionId };
    },
    collections_restore: ({ collection: c }) => {
      db.collections.push(c as Collection);
      return { collections: db.collections, activeCollectionId: db.activeCollectionId };
    },
    collections_set_skins: ({ id, add, remove }) => {
      const c = find(id);
      for (const s of add as string[]) if (!c.skinIds.includes(s)) c.skinIds.push(s);
      c.skinIds = c.skinIds.filter((s) => !(remove as string[]).includes(s));
      return c;
    },
    activate_collection: ({ id }) => {
      const members = new Set(find(id).skinIds);
      db.activeCollectionId = id as string;
      db.hangar = db.hangar.map((s) => ({ ...s, active: members.has(s.id) }));
      return db.hangar;
    },
  };
  backend.call.mockImplementation(async (cmd: string, args?: Args) => {
    const handler = handlers[cmd];
    if (!handler) throw { code: 'internal', message: `unexpected ${cmd}` } satisfies AppError;
    return clone(handler(args ?? {}));
  });
  return db;
}

/** Renders the screen (plus the toast stack) with both queries already seeded. */
function renderScreen(state: CollectionsState = COLLECTIONS, hangar: HangarSkin[] = HANGAR) {
  fakeBackend(state, hangar);
  const client = createQueryClient();
  client.setQueryData(COLLECTIONS_KEY, clone(state));
  client.setQueryData(HANGAR_KEY, clone(hangar));
  return renderWithProviders(
    <>
      <Collections />
      <Toaster />
    </>,
    { client },
  );
}

const list = () => screen.getByRole('list', { name: 'Collections' });
const card = (name: string) => within(list()).getByRole('button', { name });
const detail = (name: string) => screen.getByRole('region', { name });
const nameField = () => screen.getByRole('textbox', { name: 'Collection name' });
const descriptionField = () => screen.getByRole('textbox', { name: 'Collection description' });
const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Args);

beforeEach(() => {
  resetStores();
  resetCollectionsUi();
  backend.call.mockReset();
});

describe('Collections', () => {
  it('lists the collections and opens the active one', async () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: 'Collections' })).toBeInTheDocument();
    expect(
      screen.getByText('Activate a collection to use only its skins in the game. Others stay installed, just inactive.'),
    ).toBeInTheDocument();
    expect(within(list()).getAllByRole('button')).toHaveLength(3);

    const active = card('Historical only');
    expect(active).toHaveAttribute('aria-current', 'true');
    // Badge, description and the member count (the missing "gone" is not counted).
    expect(active).toHaveAccessibleDescription('Active Period-accurate liveries 2 skins');
    expect(within(active).getByText('In use')).toBeInTheDocument();
    expect(card('Screenshots')).not.toHaveAttribute('aria-current');
    expect(card('Screenshots')).toHaveAccessibleDescription('High-contrast skins 3 skins');
    expect(card('Fictional fun')).toHaveAccessibleDescription('0 skins');

    const pane = detail('Historical only');
    expect(nameField()).toHaveValue('Historical only');
    expect(descriptionField()).toHaveValue('Period-accurate liveries');
    expect(within(pane).getByText('2 skins · 60 MB')).toBeInTheDocument();
    expect(within(pane).getByText('Active in game')).toBeInTheDocument();
    expect(within(pane).queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();

    const members = within(pane).getByRole('list', { name: 'Skins in “Historical only”' });
    const items = within(members).getAllByRole('listitem');
    expect(items).toHaveLength(3); // two members + the "Add skins" tile
    expect(items[0]).toHaveTextContent('Kursk 1943');
    expect(items[0]).toHaveTextContent('Tiger H1');
    expect(items[1]).toHaveTextContent('Winter whitewash');
  });

  it('opens another collection on click', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(card('Screenshots'));
    expect(card('Screenshots')).toHaveAttribute('aria-current', 'true');
    expect(card('Historical only')).not.toHaveAttribute('aria-current');
    const pane = detail('Screenshots');
    expect(within(pane).getByText('3 skins · 80 MB')).toBeInTheDocument();
    expect(within(pane).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(within(pane).queryByText('Active in game')).not.toBeInTheDocument();
  });

  it('opens cards from the keyboard (Enter and Space)', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.tab(); // "+ New"
    expect(screen.getByRole('button', { name: 'New collection' })).toHaveFocus();
    await user.tab();
    expect(card('Historical only')).toHaveFocus();
    await user.tab();
    expect(card('Screenshots')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(card('Screenshots')).toHaveAttribute('aria-current', 'true');
    await user.tab();
    await user.keyboard(' ');
    expect(card('Fictional fun')).toHaveAttribute('aria-current', 'true');
    expect(card('Fictional fun')).toHaveFocus();
    expect(detail('Fictional fun')).toBeInTheDocument();
  });

  it('hides members that are no longer in the hangar', () => {
    renderScreen();
    const pane = detail('Historical only');
    expect(within(pane).queryByText('gone')).not.toBeInTheDocument();
    expect(within(pane).getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
  });

  it('+ New creates a collection, opens it and focuses its name', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('button', { name: 'New collection' }));

    expect(calls('collections_create')).toEqual([{ name: 'New collection', description: undefined }]);
    await waitFor(() => expect(nameField()).toHaveFocus());
    const field = nameField() as HTMLInputElement;
    expect(field).toHaveValue('New collection');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'New collection'.length]);
    expect(card('New collection')).toHaveAttribute('aria-current', 'true');
    expect(within(detail('New collection')).getByText('0 skins · 0 B')).toBeInTheDocument();
    expect(useCollectionsUi.getState().renameId).toBeNull();

    // Typing replaces the selected default name.
    await user.keyboard('Night ops{Enter}');
    await waitFor(() => expect(calls('collections_update')).toEqual([{ id: 'c100', name: 'Night ops', description: undefined }]));
    expect(card('Night ops')).toHaveAttribute('aria-current', 'true');
  });

  it('renames on Enter and on blur, and keeps a single update per edit', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.clear(nameField());
    await user.type(nameField(), '  Tigers only  {Enter}');
    expect(nameField()).toHaveValue('Tigers only');
    expect(nameField()).toHaveFocus();
    // The list follows at once (optimistic), then the backend confirms.
    expect(card('Tigers only')).toBeInTheDocument();
    await waitFor(() => expect(calls('collections_update')).toEqual([{ id: 'c1', name: 'Tigers only', description: undefined }]));

    await user.tab(); // blur with nothing new: no second update
    await user.click(nameField());
    await user.type(nameField(), '!');
    await user.tab();
    await waitFor(() => expect(calls('collections_update')).toHaveLength(2));
    expect(calls('collections_update')[1]).toEqual({ id: 'c1', name: 'Tigers only!', description: undefined });
    await waitFor(() => expect(card('Tigers only!')).toBeInTheDocument());
  });

  it('Escape reverts the name and closes nothing else', async () => {
    const user = userEvent.setup();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    renderScreen();
    await user.clear(nameField());
    await user.type(nameField(), 'Oops');
    await user.keyboard('{Escape}');
    expect(nameField()).toHaveValue('Historical only');
    expect(nameField()).toHaveFocus();
    expect(onWindowKey).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    await user.tab();
    expect(calls('collections_update')).toEqual([]);
    window.removeEventListener('keydown', onWindowKey);
  });

  it('a blank name reverts instead of committing', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.clear(nameField());
    await user.tab();
    expect(nameField()).toHaveValue('Historical only');
    expect(calls('collections_update')).toEqual([]);
  });

  it('edits and clears the description', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(card('Fictional fun'));
    expect(descriptionField()).toHaveValue('');
    expect(descriptionField()).toHaveAttribute('placeholder', 'Add a description');
    await user.type(descriptionField(), 'Anything goes');
    await user.tab();
    await waitFor(() =>
      expect(calls('collections_update')).toEqual([{ id: 'c3', name: undefined, description: 'Anything goes' }]),
    );
    expect(card('Fictional fun')).toHaveAccessibleDescription('Anything goes 0 skins');

    await user.clear(descriptionField());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(calls('collections_update')).toHaveLength(2));
    expect(calls('collections_update')[1]).toEqual({ id: 'c3', name: undefined, description: '' });
    expect(card('Fictional fun')).toHaveAccessibleDescription('0 skins');
  });

  it('Activate makes it the active collection and toasts', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(card('Screenshots'));
    await user.click(within(detail('Screenshots')).getByRole('button', { name: 'Activate' }));

    expect(calls('activate_collection')).toEqual([{ id: 'c2' }]);
    expect(await screen.findByText('“Screenshots” activated · 3 skins')).toBeInTheDocument();
    const pane = detail('Screenshots');
    expect(within(pane).getByText('Active in game')).toHaveFocus();
    expect(within(pane).queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(within(card('Screenshots')).getByText('In use')).toBeInTheDocument();
    expect(within(card('Historical only')).queryByText('In use')).not.toBeInTheDocument();
  });

  it('a failed activation shows the error', async () => {
    const user = userEvent.setup();
    renderScreen();
    const ok = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd: string, args?: Args) =>
      cmd === 'activate_collection'
        ? Promise.reject({ code: 'conflict', message: '1 skin could not be moved' } satisfies AppError)
        : ok(cmd, args),
    );
    await user.click(card('Screenshots'));
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('1 skin could not be moved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
  });

  it('Delete collection is undoable and Undo restores it', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(card('Screenshots'));
    await user.click(within(detail('Screenshots')).getByRole('button', { name: 'Delete collection' }));

    expect(calls('collections_delete')).toEqual([{ id: 'c2' }]);
    await waitFor(() => expect(within(list()).queryByRole('button', { name: 'Screenshots' })).not.toBeInTheDocument());
    // The active collection opens in its place, and focus follows it.
    expect(card('Historical only')).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(card('Historical only')).toHaveFocus());

    expect(await screen.findByText('Deleted “Screenshots”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(calls('collections_restore')).toEqual([
        {
          collection: {
            id: 'c2',
            name: 'Screenshots',
            description: 'High-contrast skins',
            skinIds: ['h3', 'h4', 'h1'],
            createdAt: '2026-09-01T10:00:00Z',
          },
        },
      ]),
    );
    await waitFor(() => expect(card('Screenshots')).toHaveAttribute('aria-current', 'true'));
  });

  it('Remove takes a skin out, undoably, and Undo adds it back', async () => {
    const user = userEvent.setup();
    renderScreen();
    const pane = detail('Historical only');
    await user.click(within(pane).getByRole('button', { name: 'Remove “Kursk 1943” from this collection' }));

    expect(calls('collections_set_skins')).toEqual([{ id: 'c1', add: [], remove: ['h1'] }]);
    expect(within(pane).queryByText('Kursk 1943')).not.toBeInTheDocument();
    expect(within(pane).getByText('1 skin · 20 MB')).toBeInTheDocument();
    // Focus moves to the next "Remove" instead of dropping to <body>.
    await waitFor(() =>
      expect(within(pane).getByRole('button', { name: 'Remove “Winter whitewash” from this collection' })).toHaveFocus(),
    );

    await screen.findByText('Removed from “Historical only”');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls('collections_set_skins')).toHaveLength(2));
    expect(calls('collections_set_skins')[1]).toEqual({ id: 'c1', add: ['h1'], remove: [] });
    expect(await within(pane).findByText('Kursk 1943')).toBeInTheDocument();
  });

  it('two quick removals each get their own Undo toast', async () => {
    const user = userEvent.setup();
    renderScreen();
    const pane = detail('Historical only');
    await user.click(within(pane).getByRole('button', { name: 'Remove “Kursk 1943” from this collection' }));
    await user.click(within(pane).getByRole('button', { name: 'Remove “Winter whitewash” from this collection' }));
    await waitFor(() => expect(screen.getAllByText('Removed from “Historical only”')).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
  });

  it('removing the last member hands focus to the "Add skins" tile', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(card('Screenshots'));
    const pane = detail('Screenshots');
    for (const name of ['Desert tan', 'Normandy', 'Kursk 1943']) {
      within(pane).getByRole('button', { name: `Remove “${name}” from this collection` }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(within(pane).queryByText(name)).not.toBeInTheDocument());
    }
    await waitFor(() =>
      expect(within(pane).getByRole('button', { name: /^Add skins from My Hangar/ })).toHaveFocus(),
    );
    expect(within(pane).getByText('0 skins · 0 B')).toBeInTheDocument();
  });

  it('names a member without a vehicle code "Unknown vehicle"', () => {
    const noBlk = { ...skin('h9', 'Loose textures', TIGER, 1), vehicle: { ...TIGER, code: '', name: 'whatever' } };
    renderScreen({ collections: [collection('c1', 'Misc', ['h9'])] }, [noBlk]);
    const item = within(detail('Misc')).getAllByRole('listitem')[0];
    expect(item).toHaveTextContent('Loose textures');
    expect(item).toHaveTextContent('Unknown vehicle');
  });

  it('the dashed tile goes to My Hangar', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('button', { name: 'Add skins from My Hangar (select → Move to collection)' }));
    expect(useUi.getState().screen).toBe('hangar');
  });

  it('remembers the open collection across visits', async () => {
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await user.click(card('Fictional fun'));
    unmount();
    renderScreen();
    expect(card('Fictional fun')).toHaveAttribute('aria-current', 'true');
  });

  it('shows skeletons while loading', () => {
    backend.call.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Collections />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('heading', { level: 1, name: 'Collections' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows an error with Retry when the library cannot be read', async () => {
    const user = userEvent.setup();
    fakeBackend();
    const ok = backend.call.getMockImplementation()!;
    let failing = true;
    backend.call.mockImplementation(async (cmd: string, args?: Args) =>
      failing && cmd === 'collections_list'
        ? Promise.reject({ code: 'io', message: 'library.json is locked' } satisfies AppError)
        : ok(cmd, args),
    );
    renderWithProviders(<Collections />);
    expect(await screen.findByRole('heading', { name: "Couldn't load your collections" })).toBeInTheDocument();
    expect(screen.getByText('library.json is locked')).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Collections' })).toBeInTheDocument();
  });

  it('empty: "No collections yet" and New collection', async () => {
    const user = userEvent.setup();
    renderScreen({ collections: [] });
    expect(screen.getByRole('heading', { name: 'No collections yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New collection' }));
    expect(calls('collections_create')).toEqual([{ name: 'New collection', description: undefined }]);
    await waitFor(() => expect(nameField()).toHaveFocus());
    expect(card('New collection')).toHaveAttribute('aria-current', 'true');
  });

  it('empty: a double click on New collection creates only one', async () => {
    const user = userEvent.setup();
    renderScreen({ collections: [] });
    let release!: () => void;
    const ok = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd: string, args?: Args) => {
      if (cmd === 'collections_create') await new Promise<void>((r) => (release = r));
      return ok(cmd, args);
    });
    await user.dblClick(screen.getByRole('button', { name: 'New collection' }));
    await act(async () => release());
    await waitFor(() => expect(nameField()).toHaveFocus());
    expect(calls('collections_create')).toHaveLength(1);
  });

  it('deleting the last collection moves focus to New collection', async () => {
    const user = userEvent.setup();
    renderScreen({ collections: [collection('c1', 'Solo', ['h1'])] });
    await user.click(screen.getByRole('button', { name: 'Delete collection' }));
    expect(await screen.findByRole('heading', { name: 'No collections yet' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New collection' })).toHaveFocus());
  });

  it('shows backend errors from create as a toast', async () => {
    const user = userEvent.setup();
    renderScreen();
    const ok = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd: string, args?: Args) =>
      cmd === 'collections_create'
        ? Promise.reject({ code: 'io', message: 'Disk is full' } satisfies AppError)
        : ok(cmd, args),
    );
    await user.click(screen.getByRole('button', { name: 'New collection' }));
    expect(await screen.findByText('Disk is full')).toBeInTheDocument();
    expect(within(list()).getAllByRole('button')).toHaveLength(3);
  });

  it('has no serious axe violations', async () => {
    const { container } = renderScreen();
    await act(async () => {});
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('has no serious axe violations when empty', async () => {
    const { container } = renderScreen({ collections: [] });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('Space on a card does not scroll the page', () => {
    renderScreen();
    const target = card('Screenshots');
    const event = fireEvent.keyDown(target, { key: ' ' });
    expect(event).toBe(false); // default prevented
    expect(target).toHaveAttribute('aria-current', 'true');
  });
});
