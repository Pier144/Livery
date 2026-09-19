// Seed data for the in-browser mock backend (`pnpm dev:mock`). Dev only: reached solely through
// the dynamic import of `@/dev/mockBackend` behind `MOCK_BACKEND`, so it never ships.
//
// Mirrors the prototype's sample hangar and collections (Livery Prototype.dc.html, lines 604-622)
// in the shapes of src/types.ts. Every builder returns fresh objects, so resetting the mock
// never shares state with an earlier run.

import { vehicles } from '@/data/vehicles';
import type { Author, Backup, Collection, HangarSkin, Vehicle } from '@/types';

const MB = 1024 * 1024;
const KB = 1024;

/** What detection finds: the Steam install of the prototype's First run. */
export const MOCK_GAME = {
  path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\War Thunder',
  version: '2.59.0.13',
  /** "9 skins already in UserSkins" (prototype First run). */
  existingSkins: 9,
} as const;

function vehicle(code: string): Vehicle {
  const found = vehicles.find((v) => v.code === code);
  if (!found) throw new Error(`mock data: "${code}" is not in src/data/vehicles.json`);
  return { ...found };
}

/** What the Rust scan reports for a folder without a .blk (see `vehicles::unknown`). */
function unknownVehicle(): Vehicle {
  return { code: '', name: 'Unknown vehicle', nation: 'UNK', type: 'air', class: '' };
}

function author(id: string, name: string, skinCount?: number): Author {
  return { id, name, url: `https://live.warthunder.com/user/${id}/`, ...(skinCount ? { skinCount } : {}) };
}

/** Sizes in MB as the prototype lists them, plus some KB so totals look like real folders. */
function size(mb: number, kb: number): number {
  return mb * MB + kb * KB;
}

type SkinSeed = Omit<HangarSkin, 'vehicle' | 'sizeBytes'> & { code: string | null; mb: number; kb: number };

function skin({ code, mb, kb, ...rest }: SkinSeed): HangarSkin {
  return { ...rest, vehicle: code ? vehicle(code) : unknownVehicle(), sizeBytes: size(mb, kb) };
}

const AUTHORS = {
  skyhook: () => author('61240877', 'Skyhook_Dan', 9),
  kessler: () => author('40318255', 'Kessler_Wolf', 14),
  merlin: () => author('52907314', 'Merlin_Mod'),
  redOak: () => author('38821460', 'RedOak_Petrov'),
  ironclad: () => author('70455182', 'ironclad_mia'),
};

/**
 * The library index at start: the prototype's 12 hangar skins (3 from WT Live, 9 imported or
 * made by the user). h3, h7 and h9 are inactive; h3, h4 and h9 carry the prototype's attention
 * examples. WT Live installs live in `<code>_<author>` folders, the user's own in `template_<code>`.
 */
export function seedHangar(): HangarSkin[] {
  return [
    skin({
      id: 'h_s6',
      folder: 'f_4e_Skyhook_Dan',
      name: 'SEA Camo, 388th TFW',
      code: 'f_4e',
      origin: 'wtlive',
      author: AUTHORS.skyhook(),
      mb: 29,
      kb: 312,
      active: true,
      installedAt: '2026-03-04T19:22:41Z',
      sourceId: 's6',
    }),
    skin({
      id: 'h_s4',
      folder: 'germ_leopard_2a6_Kessler_Wolf',
      name: 'Bundeswehr Flecktarn',
      code: 'germ_leopard_2a6',
      origin: 'wtlive',
      author: AUTHORS.kessler(),
      mb: 52,
      kb: 96,
      active: true,
      installedAt: '2026-09-12T17:40:25Z',
      sourceId: 's4',
    }),
    skin({
      id: 'h_s8',
      folder: 'spitfire_mk9c_Merlin_Mod',
      name: 'D-Day Invasion Stripes',
      code: 'spitfire_mk9c',
      origin: 'wtlive',
      author: AUTHORS.merlin(),
      mb: 21,
      kb: 188,
      active: true,
      installedAt: '2026-06-07T21:47:03Z',
      sourceId: 's8',
    }),
    skin({
      id: 'h1',
      folder: 'Panzer Grey 1943',
      name: 'Panzer Grey 1943',
      code: 'germ_pzkpfw_VI_ausf_b_tiger_IIH',
      origin: 'imported',
      mb: 46,
      kb: 140,
      active: true,
      installedAt: '2025-11-18T20:03:10Z',
    }),
    skin({
      id: 'h2',
      folder: 'Factory Olive',
      name: 'Factory Olive',
      code: 'ussr_t_34_85',
      origin: 'imported',
      mb: 33,
      kb: 57,
      active: true,
      installedAt: '2025-12-02T15:31:48Z',
    }),
    skin({
      id: 'h3',
      folder: 'Berlin 1945',
      name: 'Berlin 1945',
      code: 'ussr_t_34_85',
      origin: 'imported',
      mb: 31,
      kb: 402,
      active: false,
      installedAt: '2026-01-09T11:12:05Z',
      attention: [{ kind: 'missingTexture', message: 'turret_c.dds is missing', file: 'turret_c.dds' }],
    }),
    skin({
      id: 'h4',
      folder: 'template_germ_leopard_2a6',
      name: 'My Test Camo',
      code: 'germ_leopard_2a6',
      origin: 'mine',
      mb: 12,
      kb: 230,
      active: true,
      installedAt: '2026-08-23T22:18:37Z',
      // The blk is named after the vehicle code (the prototype abbreviates it to "skin.blk").
      attention: [
        { kind: 'unknownBlkBlock', message: 'germ_leopard_2a6.blk has an unknown block', file: 'germ_leopard_2a6.blk' },
      ],
    }),
    skin({
      id: 'h5',
      folder: 'Aggressor Splinter',
      name: 'Aggressor Splinter',
      code: 'f_4e',
      origin: 'imported',
      mb: 30,
      kb: 75,
      active: true,
      installedAt: '2026-02-14T09:44:19Z',
    }),
    skin({
      id: 'h6',
      folder: 'Battle of Britain',
      name: 'Battle of Britain',
      code: 'spitfire_mk9c',
      origin: 'imported',
      mb: 20,
      kb: 311,
      active: true,
      installedAt: '2025-10-27T18:26:52Z',
    }),
    skin({
      id: 'h7',
      folder: 'template_f_4e',
      name: 'Blue Angels Tribute',
      code: 'f_4e',
      origin: 'mine',
      mb: 28,
      kb: 164,
      active: false,
      installedAt: '2026-07-30T16:58:11Z',
    }),
    skin({
      id: 'h8',
      folder: 'Ariete Desert',
      name: 'Ariete Desert',
      code: 'it_c1_ariete',
      origin: 'imported',
      mb: 40,
      kb: 29,
      active: true,
      installedAt: '2026-05-16T13:07:40Z',
    }),
    skin({
      id: 'h9',
      folder: 'Flanker Sea Grey',
      name: 'Flanker Sea Grey',
      code: 'su_27',
      origin: 'imported',
      mb: 22,
      kb: 256,
      active: false,
      installedAt: '2026-09-03T10:21:33Z',
      attention: [{ kind: 'partialExtract', message: 'archive was only partially extracted' }],
    }),
  ];
}

/**
 * Folders in UserSkins that the index doesn't know yet (`scan_user_skins` reports them with a
 * `disk:<folder>` id and the folder name as the name; `import_skins` adds them).
 */
export function seedDiskOnly(): HangarSkin[] {
  return [
    skin({
      id: 'disk:template_bf-109g-6',
      folder: 'template_bf-109g-6',
      name: 'template_bf-109g-6',
      code: 'bf-109g-6',
      origin: 'mine',
      mb: 3,
      kb: 418,
      active: true,
      installedAt: '2026-09-14T20:36:02Z',
    }),
    skin({
      id: 'disk:Kursk Dust',
      folder: 'Kursk Dust',
      name: 'Kursk Dust',
      code: null,
      origin: 'imported',
      mb: 47,
      kb: 12,
      active: true,
      installedAt: '2026-09-17T08:52:44Z',
      attention: [{ kind: 'noBlk', message: "no .blk file, so the game can't use it" }],
    }),
  ];
}

/** The prototype's three collections; "Historical only" is the one activated last. */
export function seedCollections(): { collections: Collection[]; activeCollectionId: string } {
  return {
    collections: [
      {
        id: 'c1',
        name: 'Historical only',
        description: 'Period-accurate liveries for realistic battles',
        skinIds: ['h_s6', 'h_s4', 'h_s8', 'h1', 'h2', 'h6', 'h8'],
        createdAt: '2026-06-10T19:12:00Z',
      },
      {
        id: 'c2',
        name: 'Screenshots',
        description: 'High-contrast skins that read well in replays',
        skinIds: ['h_s4', 'h5', 'h7'],
        createdAt: '2026-07-02T21:40:00Z',
      },
      {
        id: 'c3',
        name: 'Fictional fun',
        description: 'Anything goes',
        skinIds: ['h7', 'h4'],
        createdAt: '2026-08-24T17:05:00Z',
      },
    ],
    activeCollectionId: 'c1',
  };
}

/** A backup plus what Undo needs (mirrors the Rust `BackupRecord`). */
export interface StoredBackup {
  backup: Backup;
  /** The index entry as it was (original id included). */
  skin: HangarSkin;
  /** Whether the folder was in UserSkins (active) or in `.livery/inactive`. */
  wasActive: boolean;
  /** Made while backups are off in Settings: only serves the Undo toast, never listed. */
  ephemeral: boolean;
}

const DAY_MS = 86_400_000;

function daysBefore(now: number, days: number, minutes: number): string {
  return new Date(now - days * DAY_MS - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Settings → Backups: "3 items · 148 MB". The older Flecktarn that the current one replaced, and
 * two WT Live skins deleted earlier (no longer in the hangar). Dated relative to `now` so they
 * stay inside the 30-day window. Newest first.
 */
export function seedBackups(now: number): StoredBackup[] {
  const flecktarn = seedHangar().find((s) => s.id === 'h_s4');
  if (!flecktarn) throw new Error('mock data: h_s4 is missing');
  return [
    {
      backup: {
        id: 'b1',
        skinId: 'h_s4',
        name: 'Bundeswehr Flecktarn',
        sizeBytes: size(51, 200),
        createdAt: daysBefore(now, 7, 95),
        reason: 'replace',
      },
      skin: { ...flecktarn, sizeBytes: size(51, 200), installedAt: '2026-04-21T08:05:12Z' },
      wasActive: true,
      ephemeral: false,
    },
    {
      backup: {
        id: 'b2',
        skinId: 'h_s2',
        name: "Winter '44 Whitewash",
        sizeBytes: size(36, 90),
        createdAt: daysBefore(now, 11, 310),
        reason: 'delete',
      },
      skin: skin({
        id: 'h_s2',
        folder: 'ussr_t_34_85_RedOak_Petrov',
        name: "Winter '44 Whitewash",
        code: 'ussr_t_34_85',
        origin: 'wtlive',
        author: AUTHORS.redOak(),
        mb: 36,
        kb: 90,
        active: true,
        installedAt: '2026-07-04T18:02:29Z',
        sourceId: 's2',
      }),
      wasActive: true,
      ephemeral: false,
    },
    {
      backup: {
        id: 'b3',
        skinId: 'h_s3',
        name: 'Desert Storm Tan',
        sizeBytes: size(61, 150),
        createdAt: daysBefore(now, 20, 42),
        reason: 'delete',
      },
      skin: skin({
        id: 'h_s3',
        folder: 'us_m1a2_sep_ironclad_mia',
        name: 'Desert Storm Tan',
        code: 'us_m1a2_sep',
        origin: 'wtlive',
        author: AUTHORS.ironclad(),
        mb: 61,
        kb: 150,
        active: false,
        installedAt: '2026-05-22T14:30:51Z',
        sourceId: 's3',
      }),
      wasActive: false,
      ephemeral: false,
    },
  ];
}

/**
 * `?many=1`: the seed hangar plus generated skins up to `total`, spread over every catalog
 * vehicle, for checking that My Hangar scrolls smoothly with 1,000 skins (BUILD_PLAN M3).
 */
export function seedManyHangar(total = 1000): HangarSkin[] {
  const base = seedHangar();
  const codes = [...new Set(base.map((s) => s.vehicle.code).filter(Boolean))];
  const origins = ['wtlive', 'imported', 'mine'] as const;
  const extra = Array.from({ length: Math.max(0, total - base.length) }, (_, i) => {
    const code = codes[i % codes.length] ?? 'f_4e';
    const n = i + 1;
    return skin({
      id: `h_many_${n}`,
      folder: `${code}_generated_${n}`,
      name: `Generated livery ${String(n).padStart(4, '0')}`,
      code,
      origin: origins[i % origins.length] ?? 'imported',
      mb: 12 + (i % 60),
      kb: (i * 37) % 1024,
      active: i % 7 !== 0,
      installedAt: '2026-08-01T12:00:00Z',
    });
  });
  return [...base, ...extra];
}
