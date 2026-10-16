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
