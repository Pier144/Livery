/**
 * The OS the webview runs on, from its user agent (WebView2 says "Windows", WebKitGTK "Linux").
 * Windows when unsure: it is the main target, and the tests' jsdom agent names neither.
 */
export function isLinuxAgent(agent: string): boolean {
  return /\bLinux\b/.test(agent) && !/\bAndroid\b/.test(agent);
}

export const IS_LINUX = typeof navigator !== 'undefined' && isLinuxAgent(navigator.userAgent);
