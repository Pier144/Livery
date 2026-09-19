import axe from 'axe-core';

/**
 * Runs axe-core on a container and returns serious/critical violations.
 * jsdom cannot compute colors, so contrast is checked against the README table instead.
 */
export async function seriousViolations(container: Element) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}
