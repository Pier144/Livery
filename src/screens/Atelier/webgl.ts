let cached: boolean | undefined;

/**
 * Whether this webview can draw with WebGL 2 (the editor's viewport and bake need it). Checked
 * once: a throwaway canvas asks for a context, which is released right away.
 */
export function hasWebGL2(): boolean {
  if (cached !== undefined) return cached;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    cached = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}
