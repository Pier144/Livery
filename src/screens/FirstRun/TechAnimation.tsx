import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

/*
 * First run technical drawing (README §1, right column): dimension lines drawing in,
 * mono annotations, an amber crosshair, a CSS 3D wireframe M4 Sherman slowly spinning,
 * a sweeping scanline and a texture atlas fading in. Purely decorative.
 *
 * Every animation is behind `motion-safe:` and the global `data-reduce-motion` rule. With
 * no animation each element's resting style is its final frame: lines fully drawn
 * (dasharray 600 > longest line, offset 0), labels and tiles visible, model at rotateX(-22deg),
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
  /**
   * `middle` centres the vehicle's dimensions over their line; `end` keeps longer translations
   * inside the sheet (x=482 is where the English text ends).
   */
  anchor?: 'middle' | 'end';
}

const LABELS: readonly Label[] = [
  { x: 280, y: 80, delayMs: 900, text: { anim: 'hull' }, anchor: 'middle' },
  { x: 490, y: 275, delayMs: 1100, text: { literal: '2740' } },
  { x: 60, y: 490, delayMs: 1300, text: { anim: 'sheet' } },
  { x: 482, y: 490, delayMs: 1500, text: { anim: 'unofficial' }, anchor: 'end' },
];

/** Texture file names in the atlas strip: file names, never translated. */
const TILES = ['hull_c', 'hull_n', 'turret_c', 'turret_n', 'tracks_c', 'skin.blk'] as const;

/*
 * The wireframe: an M4 Sherman built from flat planes in a CSS 3D scene. Each plane is a zero-size
 * div placed and turned in the model, holding an SVG path drawn in its own 2D coordinates: upright
 * planes are side views (x forward, y down), `flat` planes lie level (their y is the model's z),
 * `cross` planes face forward. Model units are 40 per metre, `K` px each.
 */

const K = 1.25;

type Pt = readonly [x: number, y: number];
type Vec = readonly [x: number, y: number, z: number];

const poly = (pts: readonly Pt[], close = true) => `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}${close ? 'Z' : ''}`;
const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1}L${x2} ${y2}`;
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}Z`;
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Plane {
  /** Model position of the plane's origin, relative to its part. */
  at: Vec;
  turn?: 'flat' | 'cross';
  d: string;
  /** Hatched area in the plane's coordinates: [x, y, width, height]. */
  hatch?: readonly [number, number, number, number];
}

interface Part {
  name: 'hull' | 'tracks' | 'turret';
  /** Model position of the part's origin. */
  at: Vec;
  planes: readonly Plane[];
}

/** Upright plane at depth `z`. */
const side = (z: number, d: string): Plane => ({ at: [0, 0, z], d });
/** Level plane at height `y`. */
const level = (y: number, d: string, hatch?: Plane['hatch']): Plane => ({ at: [0, y, 0], turn: 'flat', d, hatch });
/** Lines across the model (along z, from z1 to z2 and mirrored) through the point (x, y). */
const across = (x: number, y: number, z1: number, z2: number): Plane => ({
  at: [x, y, 0],
  turn: 'flat',
  d: z1 === -z2 ? line(0, z1, 0, z2) : line(0, z1, 0, z2) + line(0, -z2, 0, -z1),
});

/** Hull side: rear plate, sloped engine deck edge, roof, 56° glacis. It sits on the tracks (y=12). */
const HULL: readonly Pt[] = [
  [-117, 12],
  [-117, -6],
  [-110, -19],
  [58, -19],
  [104, 12],
];
const HULL_Z = 50;
/** Cast differential housing at the nose, between the tracks. */
const NOSE: readonly Pt[] = [
  [96, 8],
  [110, 14],
  [114, 24],
  [106, 32],
  [92, 30],
];
const NOSE_Z = 32;

/** Track loop on flat ground (y=55): raised front drive sprocket at (100, 26), rear idler at (-104, 36). */
const TRACK = 'M-84 55L84 55L110 36A14 14 0 0 0 100 12L-104 24A12 12 0 0 0 -112 45Z';
const TRACK_OUT = 52;
const TRACK_IN = 36;
/** VVSS suspension: three bogies of two road wheels, a return roller on each under the top run. */
const BOGIES: readonly Pt[] = [
  [-70, -46],
  [-14, 10],
  [42, 66],
];
const topRunY = (x: number) => 12 + ((100 - x) * 12) / 204;

function runningGear(): string {
  const parts = [TRACK, circle(100, 26, 9), circle(100, 26, 3), circle(-104, 36, 8)];
  for (const [a, b] of BOGIES) {
    const rx = (a + b) / 2 + 6;
    const ry = round1(topRunY(rx) + 4);
    parts.push(circle(a, 45, 10), circle(b, 45, 10), circle(a, 45, 3), circle(b, 45, 3), circle(rx, ry, 4));
    parts.push(
      poly(
        [
          [a + 4, 37],
          [a + 8, ry + 4],
          [b - 8, ry + 4],
          [b - 4, 37],
        ],
        false,
      ),
    );
  }
  return parts.join('');
}

/** Cast turret: 36 units in radius with the rear bustle, narrowing towards the roof. */
const turretRadius = (a: number) => 36 + 9 * Math.max(0, -Math.cos(a)) ** 2;
const TURRET_LEVELS: readonly (readonly [y: number, scale: number])[] = [
  [0, 1],
  [-14, 1.02],
  [-26, 0.93],
  [-34, 0.72],
];
const TURRET_ROOF = -34;
const CUPOLA = { x: -12, z: 14, r: 9, top: -41 } as const;

function turretRing(scale: number): string {
  const pts: Pt[] = [];
  for (let i = 0; i < 36; i += 1) {
    const a = (i / 36) * Math.PI * 2;
    const r = turretRadius(a) * scale;
    pts.push([round1(r * Math.cos(a)), round1(r * Math.sin(a))]);
  }
  return poly(pts);
}

/** Turret section through its axis: up the `front` side, over the roof, down the `back` side. */
function turretSection(front: number, back: number): string {
  const up = TURRET_LEVELS.map(([y, s]): Pt => [round1(turretRadius(front) * s), y]);
  const down = [...TURRET_LEVELS].reverse().map(([y, s]): Pt => [-round1(turretRadius(back) * s), y]);
  return poly([...up, ...down], false);
}

/** Box edges from its min corner: two upright faces and two level ones cover all twelve. */
function box(x: number, y: number, z: number, w: number, h: number, d: number): Plane[] {
  return [side(z, rect(x, y, w, h)), side(z + d, rect(x, y, w, h)), level(y, rect(x, z, w, d)), level(y + h, rect(x, z, w, d))];
}

const PARTS: readonly Part[] = [
  {
    name: 'hull',
    at: [0, 0, 0],
    planes: [
      side(-HULL_Z, poly(HULL)),
      side(HULL_Z, poly(HULL)),
      ...HULL.map(([x, y]) => across(x, y, -HULL_Z, HULL_Z)),
      // Engine deck, hatched, with the driver's and co-driver's hatches up front.
      level(-19, rect(34, -38, 18, 22) + rect(34, 16, 18, 22), [-110, -HULL_Z, 168, 2 * HULL_Z]),
      side(-NOSE_Z, poly(NOSE)),
      side(NOSE_Z, poly(NOSE)),
      ...NOSE.slice(1, 4).map(([x, y]) => across(x, y, -NOSE_Z, NOSE_Z)),
    ],
  },
  {
    name: 'tracks',
    at: [0, 0, 0],
    planes: [
      side(-TRACK_OUT, runningGear()),
      side(TRACK_OUT, runningGear()),
      side(-TRACK_IN, TRACK),
      side(TRACK_IN, TRACK),
      across(-84, 55, TRACK_IN, TRACK_OUT),
      across(84, 55, TRACK_IN, TRACK_OUT),
      across(100, 12, TRACK_IN, TRACK_OUT),
      across(-104, 24, TRACK_IN, TRACK_OUT),
    ],
  },
  {
    name: 'turret',
    // Turret ring a little ahead of the hull centre, on the roof.
    at: [6, -19, 0],
    planes: [
      ...TURRET_LEVELS.map(([y, s]) =>
        level(y, turretRing(s) + (y === TURRET_ROOF ? circle(CUPOLA.x, CUPOLA.z, CUPOLA.r) : '')),
      ),
      side(0, turretSection(0, Math.PI)),
      { at: [0, 0, 0], turn: 'cross', d: turretSection(Math.PI / 2, Math.PI / 2) },
      // Commander's cupola.
      level(CUPOLA.top, circle(CUPOLA.x, CUPOLA.z, CUPOLA.r)),
      side(
        CUPOLA.z,
        line(CUPOLA.x - CUPOLA.r, TURRET_ROOF, CUPOLA.x - CUPOLA.r, CUPOLA.top) +
          line(CUPOLA.x + CUPOLA.r, TURRET_ROOF, CUPOLA.x + CUPOLA.r, CUPOLA.top),
      ),
      // Gun mantlet, the 75 mm barrel and its muzzle.
      ...box(34, -24, -15, 10, 18, 30),
      ...box(44, -17.5, -2.5, 106, 5, 5),
      { at: [150, -15, 0], turn: 'cross', d: circle(0, 0, 3.5) },
    ],
  },
];

const TURN = { flat: ' rotateX(90deg)', cross: ' rotateY(90deg)' } as const;
const place = ([x, y, z]: Vec, turn?: Plane['turn']) =>
  `translate3d(${x * K}px, ${y * K}px, ${z * K}px)${turn ? TURN[turn] : ''}`;

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
          {PARTS.map((part) => (
            <div
              key={part.name}
              data-part={part.name}
              className="absolute left-1/2 top-1/2 h-0 w-0 [transform-style:preserve-3d]"
              style={{ transform: place(part.at) }}
            >
              {part.planes.map((plane, i) => (
                <div
                  key={i}
                  data-plane
                  className="absolute left-0 top-0 h-0 w-0"
                  style={{ transform: place(plane.at, plane.turn) }}
                >
                  {plane.hatch && (
                    <div
                      className="absolute bg-hatch"
                      style={{
                        left: plane.hatch[0] * K,
                        top: plane.hatch[1] * K,
                        width: plane.hatch[2] * K,
                        height: plane.hatch[3] * K,
                      }}
                    />
                  )}
                  <svg width={K} height={K} viewBox="0 0 1 1" className="absolute left-0 top-0 overflow-visible opacity-75">
                    <path d={plane.d} strokeWidth={1} vectorEffect="non-scaling-stroke" className="fill-none stroke-amber" />
                  </svg>
                </div>
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
