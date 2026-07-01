/** Current time as ISO-8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}
