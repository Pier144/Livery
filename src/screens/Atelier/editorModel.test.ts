import { describe, expect, it } from 'vitest';
import { parseModelBuffer } from '@/atelier/modelBuffer';
import { encodeMockModel } from '@/dev/mockAtelier';
import i18n from '@/i18n';
import {
  applyPercent,
  checkedName,
  enabledSlots,
  missingHqPack,
  offersHighQuality,
  partRows,
  shuffledSeed,
  slotKind,
  slotLabel,
  bodyEnabled,
  isTypingTarget,
  nextCamoColor,
} from './editorModel';

const model = parseModelBuffer(encodeMockModel('v'));
const t = i18n.getFixedT('en');

describe('editor model', () => {
  it('names slots by their texture suffix', () => {
    expect(slotKind('us_m4a3e2_sherman_jumbo_body_c')).toBe('body');
    expect(slotKind('x_TURRET_c')).toBe('turret');
    expect(slotKind('x_tracks_c')).toBeNull();
    expect(slotLabel('x_gun_c', t)).toBe('Gun');
    expect(slotLabel('x_tracks_c', t)).toBe('x_tracks');
  });

  it('paints the enabled slots the model has, in the model’s order', () => {
    const slots = [
      { texture: 'v_gun_c', enabled: true },
      { texture: 'V_BODY_C', enabled: true },
      { texture: 'v_turret_c', enabled: false },
      { texture: 'gone_c', enabled: true },
    ];
    expect(enabledSlots({ slots }, model)).toEqual(['v_body_c', 'v_gun_c']);
    expect(partRows({ slots }, model).map((r) => [r.texture, r.enabled])).toEqual([
      ['V_BODY_C', true],
      ['v_turret_c', false],
      ['v_gun_c', true],
    ]);
  });

  it('offers High quality for a body below 4096 and notices a missing HQ pack', () => {
    expect(offersHighQuality(model)).toBe(true);
    const big = { ...model, header: { ...model.header, slots: model.header.slots.map((s) => ({ ...s, width: 4096, height: 4096 })) } };
    expect(offersHighQuality(big)).toBe(false);
    const slots = model.header.slots.map((s) => ({ texture: s.texture, enabled: true }));
    expect(missingHqPack({ slots }, model)).toBe(false);
    const lowGun = { ...model, header: { ...model.header, slots: model.header.slots.map((s) => ({ ...s, hq: !s.texture.endsWith('_gun_c') })) } };
    expect(missingHqPack({ slots }, lowGun)).toBe(true);
    expect(missingHqPack({ slots: slots.map((s) => ({ ...s, enabled: !s.texture.endsWith('_gun_c') })) }, lowGun)).toBe(false);
  });

  it('splits the apply progress: bake 0 to 50, Rust 50 to 100', () => {
    expect(applyPercent(0, 3, 0)).toBe(0);
    expect(applyPercent(1, 3, 0)).toBe(17);
    expect(applyPercent(3, 3, 0)).toBe(50);
    expect(applyPercent(3, 3, 90)).toBe(95);
    expect(applyPercent(3, 3, 100)).toBe(100);
    expect(applyPercent(5, 3, 500)).toBe(100);
  });

  it('checks project names like the backend (1 to 80 characters)', () => {
    expect(checkedName('  Desert  ')).toBe('Desert');
    expect(checkedName('   ')).toBeNull();
    expect(checkedName('x'.repeat(80))).toHaveLength(80);
    expect(checkedName('x'.repeat(81))).toBeNull();
  });

  it('shuffles to another positive seed', () => {
    expect(shuffledSeed(5, () => 0.5)).not.toBe(5);
    const values = [0, 0.25];
    expect(shuffledSeed(1, () => values.shift() ?? 0.9)).toBeGreaterThan(1);
  });
});

describe('editor model (review round)', () => {
  it('gives shared parts a friendly name when theirs says what they are', () => {
    expect(slotLabel('mg_m2hb_c', t)).toBe('Machine gun m2hb');
    expect(slotLabel('net_c', t)).toBe('Net');
    expect(slotLabel('net_desert_c', t)).toBe('Net desert');
    expect(slotLabel('track_t48_c', t)).toBe('Track t48');
    expect(slotLabel('tracks_c', t)).toBe('Track');
    expect(slotLabel('us_76mm_barrel_m1_c', t)).toBe('Barrel us 76mm m1');
    expect(slotLabel('crate_c', t)).toBe('crate');
    expect(slotLabel('mg_m2hb_c', i18n.getFixedT('it'))).toBe('Mitragliatrice m2hb');
  });

  it('puts the vehicle’s own parts first (body, turret, gun, then by name) and shared ones after, by name', () => {
    const header = {
      ...model.header,
      slots: [
        { texture: 'track_c', width: 64, height: 64, hq: true, paintableByDefault: false },
        { texture: 'v_gun_c', width: 64, height: 64, hq: true, paintableByDefault: true },
        { texture: 'mg_a_c', width: 64, height: 64, hq: true, paintableByDefault: false },
        { texture: 'v_extra_c', width: 64, height: 64, hq: true, paintableByDefault: true },
        { texture: 'v_body_c', width: 64, height: 64, hq: true, paintableByDefault: true },
        { texture: 'v_turret_c', width: 64, height: 64, hq: true, paintableByDefault: true },
      ],
    };
    const slots = header.slots.map((s) => ({ texture: s.texture, enabled: true }));
    expect(partRows({ slots }, { ...model, header }).map((r) => [r.texture, r.main])).toEqual([
      ['v_body_c', true],
      ['v_turret_c', true],
      ['v_gun_c', true],
      ['v_extra_c', true],
      ['mg_a_c', false],
      ['track_c', false],
    ]);
  });

  it('knows when the body is painted', () => {
    expect(bodyEnabled({ slots: [{ texture: 'v_body_c', enabled: true }] })).toBe(true);
    expect(bodyEnabled({ slots: [{ texture: 'v_body_c', enabled: false }, { texture: 'v_gun_c', enabled: true }] })).toBe(false);
  });

  it('adds a camo colour that differs clearly from every other, the same way each time', () => {
    const dist = (a: string, b: string) => {
      const x = parseInt(a.slice(1), 16);
      const y = parseInt(b.slice(1), 16);
      return Math.max(...[16, 8, 0].map((k) => Math.abs(((x >> k) & 255) - ((y >> k) & 255))));
    };
    for (const colors of [['#56603f', '#8a7a55'], ['#ffffff'], ['#000000', '#101010'], ['#56603f', '#56603f', '#56603f']]) {
      const next = nextCamoColor(colors);
      expect(next).toMatch(/^#[0-9a-f]{6}$/);
      expect(nextCamoColor(colors)).toBe(next);
      for (const c of colors) expect(dist(c, next)).toBeGreaterThanOrEqual(40);
    }
  });

  it('treats text fields as typing, sliders, colour wells and checkboxes not', () => {
    const input = (type: string) => Object.assign(document.createElement('input'), { type });
    expect(isTypingTarget(input('text'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(input('range'))).toBe(false);
    expect(isTypingTarget(input('color'))).toBe(false);
    expect(isTypingTarget(input('checkbox'))).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
  });
});
