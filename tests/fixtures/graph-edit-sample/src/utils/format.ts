/**
 * @public
 * Format an epoch-millis timestamp as ISO 8601.
 */
export function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
