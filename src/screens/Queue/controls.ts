// 28px queue controls with the prototype's paddings (0 12px; `Button` size 28 pads 10px).

const BASE =
  'inline-flex h-ctl flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl px-3 text-meta leading-none motion-safe:transition-colors motion-safe:duration-120 aria-disabled:cursor-default aria-disabled:opacity-50';

/** Install / "Install N ready". */
export const PRIMARY_28 = `${BASE} border-0 bg-amber font-semibold text-onAmber hover:bg-amber-hover`;

/** Pick vehicle. */
export const SECONDARY_28 = `${BASE} border border-line-3 bg-bg-4 font-medium text-ink-1 hover:border-line-4`;

/** Resolve: amber outline on a faint amber fill. */
export const AMBER_OUTLINE_28 = `${BASE} border border-amber-60 bg-amber-10 font-medium text-amber hover:bg-amber-18`;

/** × remove. */
export const ICON_28 =
  'grid h-ctl w-7 flex-none place-items-center rounded-ctl text-ink-4 hover:bg-bg-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120';

/** 12px underlined text button ("Show folder", "Choose a skin folder"). */
export const TEXT_LINK =
  'text-meta leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120';
