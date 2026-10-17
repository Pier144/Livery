import { afterEach, describe, expect, it } from 'vitest';
import { applyZoom, formatZoom, normalizeZoom, stepZoom, ZOOM_STEPS } from './zoom';

describe('interface size', () => {
  afterEach(() => {
    document.documentElement.style.zoom = '';
  });

  it('steps up and down and stops at either end', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
    expect(stepZoom(1.5, 1)).toBe(1.5);
    // An unknown value counts as 100 %.
    expect(stepZoom(1.33, 1)).toBe(1.1);
  });

  it('only knows its own steps', () => {
    expect(normalizeZoom(1.25)).toBe(1.25);
    expect(normalizeZoom(1.3)).toBe(1);
    expect(normalizeZoom('1.25')).toBe(1);
    expect(normalizeZoom(undefined)).toBe(1);
  });

  it('formats the percentage in the UI language', () => {
    expect(formatZoom(1.25, 'en')).toBe('125%');
    expect(formatZoom(0.8, 'it')).toBe('80%');
    expect(formatZoom(1.5, 'fr')).toMatch(/^150\s%$/u);
  });

  it('outside the app, zooms the page with CSS', async () => {
    await applyZoom(1.25);
    expect(document.documentElement.style.zoom).toBe('1.25');
    await applyZoom(1);
    expect(document.documentElement.style.zoom).toBe('');
  });
});
