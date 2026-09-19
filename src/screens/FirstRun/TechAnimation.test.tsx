import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import en from '@/i18n/en.json';
import it_ from '@/i18n/it.json';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { TechAnimation } from './TechAnimation';

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

function stage() {
  const { container } = renderWithProviders(<TechAnimation />);
  return container.firstElementChild as HTMLElement;
}

describe('TechAnimation', () => {
  beforeEach(() => resetStores());
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('is a decorative 560×560 stage hidden from assistive tech', async () => {
    const root = stage();
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root).toHaveClass('relative', 'h-[560px]', 'w-[560px]', 'shrink-0', 'pointer-events-none');
    // Fits the ~550px column at 1100×700; 1:1 from 1280px up.
    expect(root).toHaveClass('max-xl:scale-90', 'max-xl:-m-7', 'origin-center');
    expect(await seriousViolations(root.parentElement!)).toEqual([]);
  });

  it('draws 7 dimension lines with dasharray 600 and staggered delays', () => {
    const root = stage();
    const lines = root.querySelectorAll('line[stroke-dasharray="600"]');
    expect(lines).toHaveLength(7);
    expect([...lines].map((l) => (l as SVGElement).style.animationDelay)).toEqual([
      '200ms',
      '400ms',
      '400ms',
      '500ms',
      '700ms',
      '700ms',
      '300ms',
    ]);
    for (const l of lines) {
      expect(l).toHaveClass('stroke-line-mark', 'motion-safe:animate-draw');
      expect(l).toHaveAttribute('stroke-width', '1');
    }
    const coords = (l: Element) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a)));
    expect([...lines].map(coords)).toEqual([
      [120, 90, 440, 90],
      [120, 84, 120, 96],
      [440, 84, 440, 96],
      [480, 140, 480, 400],
      [474, 140, 486, 140],
      [474, 400, 486, 400],
      [60, 470, 500, 470],
    ]);
  });

  it('draws the amber crosshair at (280, 270)', () => {
    const root = stage();
    const circle = root.querySelector('circle')!;
    expect(circle).toHaveAttribute('cx', '280');
    expect(circle).toHaveAttribute('cy', '270');
    expect(circle).toHaveAttribute('r', '3');
    expect(circle).toHaveClass('fill-amber');
    const cross = [...root.querySelectorAll('line.stroke-amber')];
    expect(cross.map((l) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a))))).toEqual([
      [268, 270, 292, 270],
      [280, 258, 280, 282],
    ]);
  });

  it('shows the annotations in English', () => {
    const root = stage();
    const texts = [...root.querySelectorAll('text')];
    expect(texts.map((t) => t.textContent)).toEqual([
      en.firstRun.anim.hull,
      '110',
      en.firstRun.anim.sheet,
      en.firstRun.anim.unofficial,
    ]);
    expect(texts.map((t) => t.style.animationDelay)).toEqual(['900ms', '1100ms', '1300ms', '1500ms']);
    expect(texts.map((t) => [Number(t.getAttribute('x')), Number(t.getAttribute('y'))])).toEqual([
      [250, 80],
      [490, 275],
      [60, 490],
      [482, 490],
    ]);
    for (const t of texts) expect(t).toHaveClass('fill-ink-4', 'font-mono', 'text-[10px]', 'motion-safe:animate-label-in');
    // "UNOFFICIAL TOOL" is end-anchored where the English text ends, so longer translations stay on the sheet.
    expect(texts[3]).toHaveAttribute('text-anchor', 'end');
    expect(texts[3]).toHaveAttribute('x', '482');
  });

  it('translates the annotations (Italian)', async () => {
    await act(async () => {
      await i18n.changeLanguage('it');
    });
    const root = stage();
    const texts = [...root.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toEqual([it_.firstRun.anim.hull, '110', it_.firstRun.anim.sheet, it_.firstRun.anim.unofficial]);
    expect(texts[0]).not.toBe(en.firstRun.anim.hull);
  });

  it('builds hull and turret as two 6-face amber wireframes, hull top hatched', () => {
    const root = stage();
    const spin = root.querySelector('[data-spin]')!;
    expect(spin).toHaveClass('[transform-style:preserve-3d]', '[transform:rotateX(-22deg)]', 'motion-safe:animate-spinBox');
    expect(spin.parentElement).toHaveClass('[perspective:900px]', 'left-[80px]', 'top-[100px]', 'w-[400px]', 'h-[340px]');

    const allFaces = root.querySelectorAll('[data-face]');
    expect(allFaces).toHaveLength(12);
    for (const f of allFaces) expect(f).toHaveClass('border', 'border-amber', 'opacity-75', 'box-border');

    const hatched = root.querySelectorAll('.bg-hatch');
    expect(hatched).toHaveLength(1);
    expect(hatched[0]).toHaveAttribute('data-face', 'top');
    expect(hatched[0]!.closest('[data-box]')).toHaveAttribute('data-box', 'hull');

    const hull = root.querySelector<HTMLElement>('[data-box="hull"]')!;
    const turret = root.querySelector<HTMLElement>('[data-box="turret"]')!;
    expect(hull.style.transform).toBe('translateY(30px)');
    expect(turret.style.transform).toBe('translateY(-52px)');

    const face = (box: HTMLElement, name: string) => box.querySelector<HTMLElement>(`[data-face="${name}"]`)!.style;
    // Hull 200×110×120: side faces are depth-wide, top/bottom are w×d.
    expect(face(hull, 'front')).toMatchObject({ width: '200px', height: '110px', transform: 'translateZ(60px)' });
    expect(face(hull, 'left')).toMatchObject({ width: '120px', height: '110px', transform: 'rotateY(-90deg) translateZ(100px)' });
    expect(face(hull, 'top')).toMatchObject({
      width: '200px',
      height: '120px',
      marginLeft: '-100px',
      marginTop: '-60px',
      transform: 'rotateX(90deg) translateZ(55px)',
    });
    // Turret 96×52×80.
    expect(face(turret, 'back')).toMatchObject({ width: '96px', height: '52px', transform: 'rotateY(180deg) translateZ(40px)' });
    expect(face(turret, 'bottom')).toMatchObject({ width: '96px', height: '80px', transform: 'rotateX(-90deg) translateZ(26px)' });
  });

  it('sweeps an amber scanline across the drawing', () => {
    const scan = stage().querySelector('[data-scanline]')!;
    expect(scan).toHaveClass('bg-scanline', 'h-px', 'w-[400px]', 'left-[80px]', 'top-[100px]', 'motion-safe:animate-scan');
  });

  it('fades in 6 atlas tiles with a 180ms stagger from 1.2s', () => {
    const root = stage();
    const tiles = [...root.querySelectorAll<HTMLElement>('[data-tile]')];
    expect(tiles.map((t) => t.textContent)).toEqual(['hull_c', 'hull_n', 'turret_c', 'turret_n', 'tracks_c', 'skin.blk']);
    expect(tiles.map((t) => t.style.animationDelay)).toEqual(['1200ms', '1380ms', '1560ms', '1740ms', '1920ms', '2100ms']);
    tiles.forEach((t, i) => {
      expect(t).toHaveClass('h-11', 'w-11', 'border-line-4', 'font-mono', 'text-[8px]', 'text-ink-5', 'motion-safe:animate-tile-in');
      expect(t).toHaveClass(i % 3 === 1 ? 'bg-placeholder-tile' : 'bg-bg-tile');
    });
  });

  it('animates only behind motion-safe, so reduced motion leaves the final frame', () => {
    const root = stage();
    const all = [root, ...root.querySelectorAll('*')];
    const cls = all.flatMap(classes);
    // No unconditional animation anywhere.
    expect(cls.filter((c) => c.startsWith('animate-'))).toEqual([]);
    // 7 lines + 4 labels + box + scanline + 6 tiles.
    expect(cls.filter((c) => c.startsWith('motion-safe:animate-'))).toHaveLength(19);
    // The static state is fully visible: nothing starts hidden or undrawn outside the keyframes.
    for (const el of all) {
      const style = (el as HTMLElement).style;
      expect(style.opacity).toBe('');
      expect(style.strokeDashoffset).toBe('');
      expect(style.animation).toBe('');
    }
  });
});
