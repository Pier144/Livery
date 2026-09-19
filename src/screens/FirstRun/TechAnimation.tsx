import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

/*
 * First run technical drawing (README §1, right column): dimension lines drawing in,
 * mono annotations, an amber crosshair, a CSS 3D wireframe hull + turret slowly spinning,
 * a sweeping scanline and a texture atlas fading in. Purely decorative.
 *
 * Every animation is behind `motion-safe:` and the global `data-reduce-motion` rule. With
 * no animation each element's resting style is its final frame: lines fully drawn
 * (dasharray 600 > longest line, offset 0), labels and tiles visible, box at rotateX(-22deg),
 * scanline at the top. Per-element delays are inline because they are data-driven.
 */

type Line = readonly [x1: number, y1: number, x2: number, y2: number, delayMs: number];

const LINES: readonly Line[] = [
  [120, 90, 440, 90, 200],
  [120, 84, 120, 96, 400],
  [440, 84, 440, 96, 400],
  [480, 140, 480, 400, 500],
  [474, 140, 486, 140, 700],
  [474, 400, 486, 400, 700],
  [60, 470, 500, 470, 300],
];

/** Annotations under `firstRun.anim.*`. */
type AnimKey = 'hull' | 'sheet' | 'unofficial';

interface Label {
  x: number;
  y: number;
  delayMs: number;
  /** Translated annotation, or a literal (dimensions are not translated). */
  text: { anim: AnimKey } | { literal: string };
  /** `end` keeps longer translations inside the sheet; x=482 is where the English text ends. */
  anchor?: 'end';
}

const LABELS: readonly Label[] = [
  { x: 250, y: 80, delayMs: 900, text: { anim: 'hull' } },
  { x: 490, y: 275, delayMs: 1100, text: { literal: '110' } },
  { x: 60, y: 490, delayMs: 1300, text: { anim: 'sheet' } },
  { x: 482, y: 490, delayMs: 1500, text: { anim: 'unofficial' }, anchor: 'end' },
];

/** Texture file names in the atlas strip: file names, never translated. */
const TILES = ['hull_c', 'hull_n', 'turret_c', 'turret_n', 'tracks_c', 'skin.blk'] as const;

interface Box {
  name: 'hull' | 'turret';
  w: number;
  h: number;
  d: number;
  /** Vertical offset of the box centre inside the 400×340 scene. */
  y: number;
  hatchTop: boolean;
}

const BOXES: readonly Box[] = [
  { name: 'hull', w: 200, h: 110, d: 120, y: 30, hatchTop: true },
  { name: 'turret', w: 96, h: 52, d: 80, y: -52, hatchTop: false },
];

type FaceName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/** The six faces of a w×h×d box centred on the origin: [name, width, height, transform]. */
function faces({ w, h, d }: Box): [FaceName, number, number, string][] {
  return [
    ['front', w, h, `translateZ(${d / 2}px)`],
    ['back', w, h, `rotateY(180deg) translateZ(${d / 2}px)`],
    ['left', d, h, `rotateY(-90deg) translateZ(${w / 2}px)`],
    ['right', d, h, `rotateY(90deg) translateZ(${w / 2}px)`],
    ['top', w, d, `rotateX(90deg) translateZ(${h / 2}px)`],
    ['bottom', w, d, `rotateX(-90deg) translateZ(${h / 2}px)`],
  ];
}

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

export function TechAnimation() {
  const { t } = useTranslation();

  // 560×560 stage. Below 1280px the column is ~550px wide, so the drawing is scaled to 90%
  // and the negative margin shrinks its layout box to match (504px): nothing overflows.
  return (
    <div
      aria-hidden
      className="pointer-events-none relative h-[560px] w-[560px] shrink-0 origin-center max-xl:-m-7 max-xl:scale-90"
    >
      <svg width={560} height={560} viewBox="0 0 560 560" className="absolute inset-0">
        {LINES.map(([x1, y1, x2, y2, ms]) => (
          <line
            key={`${x1},${y1},${x2},${y2}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            strokeWidth={1}
            strokeDasharray={600}
            className="stroke-line-mark motion-safe:animate-draw"
            style={delay(ms)}
          />
        ))}
        {LABELS.map(({ x, y, delayMs, text, anchor }) => (
          <text
            key={`${x},${y}`}
            x={x}
            y={y}
            textAnchor={anchor}
            className="fill-ink-4 font-mono text-[10px] motion-safe:animate-label-in"
            style={delay(delayMs)}
          >
            {'anim' in text ? t(`firstRun.anim.${text.anim}`) : text.literal}
          </text>
        ))}
        <circle cx={280} cy={270} r={3} className="fill-amber" />
        <line x1={268} y1={270} x2={292} y2={270} strokeWidth={1} className="stroke-amber" />
        <line x1={280} y1={258} x2={280} y2={282} strokeWidth={1} className="stroke-amber" />
      </svg>

      <div className="absolute left-[80px] top-[100px] h-[340px] w-[400px] [perspective:900px]">
        <div
          data-spin
          className="absolute inset-0 [transform-style:preserve-3d] [transform:rotateX(-22deg)] motion-safe:animate-spinBox"
        >
          {BOXES.map((box) => (
            <div
              key={box.name}
              data-box={box.name}
              className="absolute inset-0 [transform-style:preserve-3d]"
              style={{ transform: `translateY(${box.y}px)` }}
            >
              {faces(box).map(([face, w, h, transform]) => (
                <div
                  key={face}
                  data-face={face}
                  className={cn(
                    'absolute left-1/2 top-1/2 box-border border border-amber opacity-75',
                    box.hatchTop && face === 'top' && 'bg-hatch',
                  )}
                  style={{ width: w, height: h, marginLeft: -w / 2, marginTop: -h / 2, transform }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div
        data-scanline
        className="absolute left-[80px] top-[100px] h-px w-[400px] bg-scanline motion-safe:animate-scan"
      />

      <div className="absolute left-[60px] top-[500px] flex gap-1.5">
        {TILES.map((name, i) => (
          <div
            key={name}
            data-tile={name}
            className={cn(
              'box-border flex h-11 w-11 items-end border border-line-4 p-[3px] font-mono text-[8px] leading-[normal] text-ink-5 motion-safe:animate-tile-in',
              i % 3 === 1 ? 'bg-placeholder-tile' : 'bg-bg-tile',
            )}
            style={delay(1200 + i * 180)}
          >
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}
