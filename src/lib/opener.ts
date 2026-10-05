import type { TFunction } from 'i18next';
import { isTauri } from '@/lib/tauri';
import { toast } from '@/store/toasts';

/**
 * Opening things outside Livery (tauri-plugin-opener): links in the default browser, folders in
 * the file manager.
 *
 * Only two kinds of link are ever opened: a WT Live page (a post or an author) and Livery's own
 * repository. A WT Live payload could carry any string in `postUrl` / `author.url`, so every URL
 * goes through the allow-list here before it reaches the plugin; the capability
 * (src-tauri/capabilities/default.json) scopes `opener:allow-open-url` to the same two places, so a
 * URL that slipped past this check would fail there too.
 */

const WTLIVE_HOST = 'live.warthunder.com';
const REPO_PATH = '/Pier144/Livery';

/** Livery's repository (Settings → About → Source code). */
export const REPO_URL = 'https://github.com/Pier144/Livery';
/** Where problems are reported (Settings → About → Report a problem). */
export const ISSUES_URL = 'https://github.com/Pier144/Livery/issues';

/** Which links a caller accepts: any allowed one, or only WT Live pages (links from a WT Live payload). */
export type LinkScope = 'any' | 'wtlive';

/** What happened to a link: opened, put on the clipboard instead, refused, or neither worked. */
export type OpenOutcome = 'opened' | 'copied' | 'refused' | 'failed';

/** Parses an https URL with no credentials and no explicit port; null for anything else. */
function parseHttps(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  return parsed;
}

function isWtLive(parsed: URL): boolean {
  return parsed.hostname === WTLIVE_HOST;
}

function isRepo(parsed: URL): boolean {
  return parsed.hostname === 'github.com' && (parsed.pathname === REPO_PATH || parsed.pathname.startsWith(`${REPO_PATH}/`));
}

/** A WT Live page (https, live.warthunder.com, default port, no credentials). */
export function isWtLiveUrl(url: string): boolean {
  const parsed = parseHttps(url);
  return parsed !== null && isWtLive(parsed);
}

/**
 * Whether Livery may hand this URL to the browser: https, no credentials or port, and either a WT
 * Live page or Livery's repository (exactly, or a page under it). `http:`, other hosts, look-alike
 * hosts (`live.warthunder.com.example`), `javascript:` and relative strings are refused.
 */
export function isAllowedUrl(url: string, scope: LinkScope = 'any'): boolean {
  const parsed = parseHttps(url);
  if (!parsed) return false;
  return isWtLive(parsed) || (scope === 'any' && isRepo(parsed));
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The desktop app's browser opener, or a new tab in browser dev / the mock. */
async function openInBrowser(url: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return true;
    } catch (e) {
      console.warn('[livery] opening the browser failed', e);
      return false;
    }
  }
  // `noopener` would make window.open return null even on success, so the opener is cut by hand.
  const win = window.open(url, '_blank');
  if (!win) return false;
  win.opener = null;
  return true;
}

/**
 * Opens an allowed URL in the default browser. When that fails the link goes to the clipboard, so
 * the user can still reach the page. A URL outside the allow-list is never opened nor copied.
 */
export async function openExternalUrl(url: string, scope: LinkScope = 'any'): Promise<OpenOutcome> {
  if (!isAllowedUrl(url, scope)) {
    console.warn('[livery] refused to open a link outside WT Live and the Livery repository');
    return 'refused';
  }
  const href = new URL(url).href;
  if (await openInBrowser(href)) return 'opened';
  return (await copyText(href)) ? 'copied' : 'failed';
}

/** `openExternalUrl` plus the toast that explains a copy, a refusal or a failure. */
export async function openLink(url: string, t: TFunction, scope: LinkScope = 'any'): Promise<OpenOutcome> {
  const outcome = await openExternalUrl(url, scope);
  if (outcome === 'copied') toast(t('common.link.copied'));
  else if (outcome === 'refused') toast(t('common.link.refused'));
  else if (outcome === 'failed') toast(t('common.link.failed', { url }));
  return outcome;
}

/**
 * Shows a folder (a path from the backend, never one typed or taken from a payload) in the file
 * manager. False outside the desktop app or when the plugin fails.
 */
export async function revealInExplorer(path: string): Promise<boolean> {
  if (!path || !isTauri()) return false;
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
    return true;
  } catch (e) {
    console.warn('[livery] showing a folder in the file manager failed', e);
    return false;
  }
}

/** `revealInExplorer` plus a toast when the folder can't be shown. */
export async function showInExplorer(path: string, t: TFunction): Promise<boolean> {
  const ok = await revealInExplorer(path);
  if (!ok) toast(t('common.explorerFailed'));
  return ok;
}
