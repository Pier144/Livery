import type { QueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/queries/settings';
import { renderWithProviders } from '@/test/render';
import type { ReduceMotion, Settings } from '@/types';
import { MOTION_OVERRIDE_ATTR, motionSafeCss, useReduceMotion } from './useReduceMotion';

function Probe() {
  useReduceMotion();
  return null;
}

const root = document.documentElement;

/** Seeds new settings and lets the query observers (notified on a timeout) re-render. */
async function setSettings(client: QueryClient, patch: Partial<Settings>) {
  await act(async () => {
    client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...patch });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const override = () => document.head.querySelector(`style[${MOTION_OVERRIDE_ATTR}]`);

/** A stylesheet shaped like Tailwind's output for `motion-safe:` utilities. */
function addTailwindLikeSheet() {
  const style = document.createElement('style');
  style.textContent = `
    .plain { color: red; }
    @media (prefers-reduced-motion: no-preference) {
      .motion-safe\\:transition-colors { transition-duration: 120ms; }
    }
    @media (min-width: 1280px) {
      .wide { color: blue; }
    }
    @media (prefers-reduced-motion: reduce) {
      .motion-reduce\\:hidden { display: none; }
    }
  `;
  document.head.appendChild(style);
  return style;
}

afterEach(() => {
  delete root.dataset.reduceMotion;
  document.head.querySelectorAll('style').forEach((s) => s.remove());
});

describe('useReduceMotion', () => {
  it('sets the html data attribute for on / off and removes it for system', async () => {
    const { client, unmount } = renderWithProviders(<Probe />, { settings: {} });
    expect(root.dataset.reduceMotion).toBeUndefined();

    const set = (reduceMotion: ReduceMotion) => setSettings(client, { reduceMotion });

    await set('on');
    expect(root.dataset.reduceMotion).toBe('true');
    expect(override()).toBeNull();
    await set('off');
    expect(root.dataset.reduceMotion).toBe('false');
    expect(override()).not.toBeNull();
    await set('system');
    expect(root.dataset.reduceMotion).toBeUndefined();
    expect(override()).toBeNull();

    await set('on');
    unmount();
    expect(root.dataset.reduceMotion).toBeUndefined();
  });

  it('"off" re-applies the motion-safe rules outside their media query', async () => {
    addTailwindLikeSheet();
    const { client } = renderWithProviders(<Probe />, { settings: { reduceMotion: 'off' } });
    const css = override()?.textContent ?? '';
    expect(css).toContain('.motion-safe\\:transition-colors');
    expect(css).toContain('120ms');
    expect(css).not.toContain('prefers-reduced-motion');
    expect(css).not.toContain('.plain');
    expect(css).not.toContain('.wide');
    expect(css).not.toContain('motion-reduce');

    await setSettings(client, { reduceMotion: 'system' });
    expect(override()).toBeNull();
  });

  it('keeps an outer condition around nested motion-safe rules and skips unreadable sheets', () => {
    const rule = (cssText: string) => ({ cssText }) as CSSRule;
    const list = (rules: CSSRule[]) => rules as unknown as CSSRuleList;
    const media = (mediaText: string, rules: CSSRule[]) =>
      ({ cssText: '', media: { mediaText } as MediaList, cssRules: list(rules) }) as unknown as CSSRule;
    const sheet = {
      cssRules: list([
        media('(min-width: 1280px)', [media('(prefers-reduced-motion: no-preference)', [rule('.a { transition: none; }')])]),
        media('(prefers-reduced-motion:no-preference)', [rule('@keyframes spin { to { rotate: 1turn; } }')]),
      ]),
    } as unknown as CSSStyleSheet;
    const crossOrigin = {
      get cssRules(): CSSRuleList {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    } as unknown as CSSStyleSheet;

    expect(motionSafeCss([crossOrigin, sheet])).toBe(
      '@media (min-width: 1280px) {\n.a { transition: none; }\n}\n@keyframes spin { to { rotate: 1turn; } }',
    );
  });
});
