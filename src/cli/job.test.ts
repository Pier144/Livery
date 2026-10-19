import { describe, expect, it, vi } from 'vitest';
import type { OrbitState } from '@/atelier/gl/scene';
import { atToNdc, isCliError, viewName, viewOrbit, type ViewArg } from './job';

const FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

describe('atToNdc', () => {
  it('maps the picture corners to NDC (y up)', () => {
    expect(atToNdc([0, 0])).toEqual([-1, 1]);
    expect(atToNdc([1, 1])).toEqual([1, -1]);
    expect(atToNdc([0.5, 0.5])).toEqual([0, 0]);
    expect(atToNdc([0.25, 0.75])).toEqual([-0.5, -0.5]);
  });
});

describe('viewName', () => {
  it('names quick views by name and orbits by their numbers, file-name safe (as cli_file checks)', () => {
    const views: ViewArg[] = [
      { kind: 'quick', name: 'front' },
      { kind: 'quick', name: 'top' },
      { kind: 'orbit', theta: 0.5, phi: 1.2, zoom: 1 },
      { kind: 'orbit', theta: -3.14159, phi: 0.01, zoom: 6 },
    ];
    const names = views.map(viewName);
    expect(names).toEqual(['front', 'top', 'orbit_0.50_1.20_1.00', 'orbit_-3.14_0.01_6.00']);
    for (const n of names) expect(`${n}.png`).toMatch(FILE_NAME);
  });
});

describe('viewOrbit', () => {
  const orbit: OrbitState = { target: [0, 0, 0], radius: 2, theta: 0, phi: 1 };

  it('frames a quick view with quickOrbit', () => {
    const scene = { quickOrbit: vi.fn(() => orbit), orbitFor: vi.fn() };
    expect(viewOrbit({ kind: 'quick', name: 'rear' }, scene)).toBe(orbit);
    expect(scene.quickOrbit).toHaveBeenCalledWith('rear');
    expect(scene.orbitFor).not.toHaveBeenCalled();
  });

  it('turns an orbit view into orbitFor(theta, phi, zoom)', () => {
    const scene = { quickOrbit: vi.fn(), orbitFor: vi.fn(() => orbit) };
    expect(viewOrbit({ kind: 'orbit', theta: 0.5, phi: 1.2, zoom: 2 }, scene)).toBe(orbit);
    expect(scene.orbitFor).toHaveBeenCalledWith(0.5, 1.2, 2);
    expect(scene.quickOrbit).not.toHaveBeenCalled();
  });
});

describe('isCliError', () => {
  it('needs a string code and message', () => {
    expect(isCliError({ code: 'noHit', message: 'x' })).toBe(true);
    expect(isCliError({ code: 1, message: 'x' })).toBe(false);
    expect(isCliError(new Error('x'))).toBe(false);
    expect(isCliError(null)).toBe(false);
  });
});
