import { useEffect } from 'react';
import { useSettings } from '@/queries/settings';
import type { ReduceMotion } from '@/types';

/** `<style>` holding the motion-safe rules without their media query (Reduce motion: Off). */
export const MOTION_OVERRIDE_ATTR = 'data-livery-motion';

/** Tailwind's `motion-safe:` variant compiles to this query. */
const NO_PREFERENCE = '(prefers-reduced-motion:no-preference)';

type MediaRuleLike = CSSRule & { media: MediaList; cssRules: CSSRuleList };

const isMediaRule = (rule: CSSRule): rule is MediaRuleLike => 'media' in rule && 'cssRules' in rule;
const normalized = (media: string) => media.replace(/\s+/g, '').toLowerCase();

function extract(rules: CSSRuleList): string[] {
  const out: string[] = [];
  for (const rule of Array.from(rules)) {
    if (!isMediaRule(rule)) continue;
    const media = rule.media.mediaText;
    if (normalized(media) === NO_PREFERENCE) {
      // Unwrapped: these rules now apply whatever the OS preference is.
      for (const inner of Array.from(rule.cssRules)) out.push(inner.cssText);
      continue;
    }
    // e.g. a breakpoint around a motion-safe rule: keep the outer condition.
    const nested = extract(rule.cssRules);
    if (nested.length > 0) out.push(`@media ${media} {\n${nested.join('\n')}\n}`);
  }
  return out;
}

/**
 * CSS text of every `motion-safe:` rule in `sheets`, outside its `prefers-reduced-motion: no-preference`
 * media query. Sheets that can't be read (cross-origin) are skipped.
 */
export function motionSafeCss(sheets: Iterable<CSSStyleSheet>): string {
  const out: string[] = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    out.push(...extract(rules));
  }
  return out.join('\n');
}

/**
 * Applies a Reduce motion mode to the document; returns the undo.
 * - `on`: `data-reduce-motion="true"` (index.css then stops every animation and transition).
 * - `system`: no attribute; the `motion-safe:` variant follows the OS preference.
 * - `off`: `data-reduce-motion="false"` plus a copy of the `motion-safe:` rules without their media query,
 *   so motion plays even when Windows asks to reduce it. Components keep using `motion-safe:` only.
 *   (The copy is taken when the mode is applied; in dev, CSS edited afterwards needs a reload.)
 */
export function applyReduceMotion(mode: ReduceMotion, doc: Document = document): () => void {
  const root = doc.documentElement;
  if (mode === 'system') {
    delete root.dataset.reduceMotion;
    return () => {};
  }
  root.dataset.reduceMotion = mode === 'on' ? 'true' : 'false';
  let override: HTMLStyleElement | null = null;
  if (mode === 'off') {
    override = doc.createElement('style');
    override.setAttribute(MOTION_OVERRIDE_ATTR, 'off');
    override.textContent = motionSafeCss(Array.from(doc.styleSheets));
    doc.head.appendChild(override);
  }
  return () => {
    override?.remove();
    delete root.dataset.reduceMotion;
  };
}

/** Settings → General → Reduce motion, applied to the whole window (mounted once in App). */
export function useReduceMotion() {
  const { data } = useSettings();
  const mode = data?.reduceMotion ?? 'system';
  useEffect(() => applyReduceMotion(mode), [mode]);
}
