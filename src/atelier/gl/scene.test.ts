import { describe, expect, it } from 'vitest';
import {
  defaultOrbit,
  FOV,
  framingDistance,
  orbitDrag,
  orbitPosition,
  orbitZoom,
  PHI_MAX,
  PHI_MIN,
  projectedRadius,
  quickViewOrbit,
  toStraightTopDown,
  ZOOM_MAX,
  ZOOM_MIN,
} from './scene';

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe('scene camera maths', () => {
  it('frames a sphere: the wider the FOV the closer, and a view narrower than tall steps back', () => {
    const d = framingDistance(2);
    expect(d).toBeGreaterThan(2 / Math.sin((FOV * Math.PI) / 360));
    expect(framingDistance(2, 60)).toBeLessThan(d);
    expect(framingDistance(2, FOV, 0.5)).toBeGreaterThan(d);
    expect(framingDistance(2, FOV, 2)).toBeCloseTo(d);
    expect(framingDistance(0)).toBe(framingDistance(1));
  });

  it('quick views look at the nose along −X, from the left (−Z), from behind and from above', () => {
    const c: [number, number, number] = [1, 2, 3];
    const pos = (v: Parameters<typeof quickViewOrbit>[0]) => orbitPosition(quickViewOrbit(v, c, 10));
    const front = pos('front');
    expect(front[0]).toBeGreaterThan(c[0] + 5);
    expect(front[2]).toBeCloseTo(c[2]);
    const rear = pos('rear');
    expect(rear[0]).toBeLessThan(c[0] - 5);
    const side = pos('side');
    expect(side[2]).toBeLessThan(c[2] - 5);
    expect(side[0]).toBeCloseTo(c[0]);
    const top = pos('top');
    expect(top[1]).toBeCloseTo(c[1] + 10, 2);
    // Just behind the zenith, so the nose points up the screen.
    expect(top[0]).toBeLessThan(c[0]);
  });

  it('orbit positions sit at the radius around the target', () => {
    const o = defaultOrbit([0, 1, 0], 5);
    const p = orbitPosition(o);
    expect(Math.hypot(p[0], p[1] - 1, p[2])).toBeCloseTo(5);
  });

  it('dragging turns the azimuth and clamps the polar angle short of the poles', () => {
    const o = defaultOrbit([0, 0, 0], 5);
    const turned = orbitDrag(o, 100, 0);
    expect(turned.theta).toBeGreaterThan(o.theta);
    expect(turned.phi).toBe(o.phi);
    expect(orbitDrag(o, 0, 10_000).phi).toBe(PHI_MIN);
    expect(orbitDrag(o, 0, -10_000).phi).toBe(PHI_MAX);
  });

  it('zoom stays within the framing limits', () => {
    const o = defaultOrbit([0, 0, 0], 5);
    expect(orbitZoom(o, -100, 5).radius).toBeLessThan(5);
    expect(orbitZoom(o, 100, 5).radius).toBeGreaterThan(5);
    expect(orbitZoom(o, -1e6, 5).radius).toBeCloseTo(5 * ZOOM_MIN);
    expect(orbitZoom(o, 1e6, 5).radius).toBeCloseTo(5 * ZOOM_MAX);
  });

  it('projects a brush radius to screen pixels', () => {
    // At the distance where the half-height of the view spans exactly `r`, r covers half the view height.
    const r = 1;
    const d = r / Math.tan((FOV * Math.PI) / 360);
    expect(projectedRadius(r, d, 800)).toBeCloseTo(400);
    expect(projectedRadius(r, 2 * d, 800)).toBeCloseTo(200);
    expect(projectedRadius(r, 0, 800)).toBe(0);
  });

  it('turns a WebGL read-back into top-down rows with straight alpha', () => {
    // 1×2: bottom row (first in GL) half-transparent red premultiplied, top row opaque blue.
    const gl = new Uint8Array([128, 0, 0, 128, 0, 0, 255, 255]);
    const out = toStraightTopDown(gl, 1, 2);
    expect(close([...out.slice(0, 4)], [0, 0, 255, 255])).toBe(true);
    expect([...out.slice(4, 8)]).toEqual([255, 0, 0, 128]);
    // Fully transparent pixels stay zero.
    expect([...toStraightTopDown(new Uint8Array(4), 1, 1)]).toEqual([0, 0, 0, 0]);
  });
});
