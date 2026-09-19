// Spread into tailwind.config: theme: { extend: { ...require('./tokens/tailwind.tokens.cjs') } }
module.exports = {
  colors: {
    bg: { 0: '#0f1012', 1: '#111214', 2: '#131416', 3: '#18191c', 4: '#1f2024', 5: '#26272c', hover: '#1c1d21', input: '#17181b', chip: '#1b1c20', status: '#141518', scrim: 'rgba(19,20,22,.85)', skel: '#222327', tile: '#1a1b1e' },
    line: { 1: '#1f2024', 2: '#26272c', 3: '#2e2f35', 4: '#3a3b41', mark: '#4a4c54', grid: '#1c1d21' },
    // ink-4 is #80828a (handoff: #7c7e86) so small text meets 4.5:1 on bg-3 and inputs too (DESIGN_NOTES).
    ink: { 1: '#ececee', 2: '#c9cbd1', 3: '#9a9ca3', 4: '#80828a', 5: '#6b6d74' },
    amber: { DEFAULT: 'oklch(0.78 0.16 70)', hover: 'oklch(0.85 0.14 75)', 10: 'oklch(0.78 0.16 70 / .10)', 18: 'oklch(0.78 0.16 70 / .18)', 35: 'oklch(0.78 0.16 70 / .35)', 50: 'oklch(0.78 0.16 70 / .50)', 60: 'oklch(0.78 0.16 70 / .60)' },
    danger: { DEFAULT: 'oklch(0.75 0.15 25)', 8: 'oklch(0.75 0.15 25 / .08)', 40: 'oklch(0.75 0.15 25 / .40)', close: 'oklch(0.55 0.18 25)' },
    onAmber: '#131416',
    overlay: 'rgba(11,11,12,.6)',
  },
  fontFamily: { sans: ['Geist', 'system-ui', 'sans-serif'], mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'] },
  fontSize: {
    display: ['30px', { lineHeight: '1.15', letterSpacing: '-0.01em', fontWeight: '500' }],
    title: ['20px', { lineHeight: '1.2', fontWeight: '500' }],
    'heading-lg': ['18px', { lineHeight: '1.3', fontWeight: '500' }],
    heading: ['16px', { lineHeight: '1.3', fontWeight: '500' }],
    card: ['14px', { lineHeight: '1.3', fontWeight: '500' }],
    body: ['13px', { lineHeight: '1.5' }],
    meta: ['12px', { lineHeight: '1.4' }],
    'mono-data': ['12px', { lineHeight: '1.4' }],
    'mono-sm': ['11px', { lineHeight: '1.4' }],
    'mono-label': ['10px', { lineHeight: '1.2', letterSpacing: '0.08em' }],
    brand: ['12px', { letterSpacing: '0.14em', fontWeight: '600' }],
  },
  spacing: { 4.5: '18px', 5.5: '22px', 7: '28px', 'titlebar': '38px', 'sidebar': '216px', 'sidebar-c': '56px', 'ctl': '28px', 'nav': '34px', 'btn': '30px', 'btn-lg': '36px' },
  borderRadius: { tag: '3px', menu: '4px', ctl: '6px', card: '8px', pill: '9px', dialog: '10px' },
  boxShadow: {
    menu: '0 12px 32px rgba(0,0,0,.5)',
    dialog: '0 30px 80px rgba(0,0,0,.7)',
    card: '0 8px 24px rgba(0,0,0,.45)',
    glow: '0 0 8px oklch(0.78 0.16 70 / .6)',
  },
  backgroundImage: {
    grid: 'linear-gradient(#1c1d21 1px, transparent 1px), linear-gradient(90deg, #1c1d21 1px, transparent 1px)',
    placeholder: 'repeating-linear-gradient(135deg,#1e1f23 0 10px,#232428 10px 20px)',
    shimmer: 'linear-gradient(90deg,#1c1d21 25%,#232428 50%,#1c1d21 75%)',
    // Small stripes: First run import thumbs (6px) and atlas tiles (5px).
    'placeholder-thumb': 'repeating-linear-gradient(135deg,#1e1f23 0 6px,#26272c 6px 12px)',
    'placeholder-tile': 'repeating-linear-gradient(135deg,#1e1f23 0 5px,#26272c 5px 10px)',
    // First run technical drawing: hatched top face and the sweeping scanline.
    hatch: 'repeating-linear-gradient(45deg,transparent 0 9px,oklch(0.78 0.16 70 / .18) 9px 10px)',
    scanline: 'linear-gradient(90deg,transparent,oklch(0.78 0.16 70 / .5),transparent)',
  },
  backgroundSize: { grid: '28px 28px', shimmer: '200% 100%' },
  backgroundPosition: { grid: '-1px -1px' },
  transitionDuration: { 120: '120ms', 150: '150ms', 250: '250ms' },
  keyframes: {
    shimmer: { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
    pulse6: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
    toastIn: { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
    spinBox: { from: { transform: 'rotateX(-22deg) rotateY(0)' }, to: { transform: 'rotateX(-22deg) rotateY(360deg)' } },
    scan: { from: { transform: 'translateY(0)' }, to: { transform: 'translateY(300px)' } },
    draw: { from: { strokeDashoffset: '600' }, to: { strokeDashoffset: '0' } },
  },
  animation: {
    shimmer: 'shimmer 1.4s linear infinite',
    pulse6: 'pulse6 1.2s ease-in-out infinite',
    toastIn: 'toastIn 200ms ease-out',
    spinBox: 'spinBox 28s linear infinite',
    scan: 'scan 7s linear infinite',
    // First run drawing; per-element delays come from [animation-delay:…] utilities.
    draw: 'draw 1.6s ease both',
    'label-in': 'toastIn .8s ease both',
    'tile-in': 'toastIn .6s ease both',
  },
};
