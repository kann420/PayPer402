/**
 * `npm run dev:stack` step 0 (build spec): every port must be free before anything starts. A hard
 * kill on Windows skips the exit handler and leaves the children listening, so a second run would
 * otherwise fail half-way through. The probe is injected, so this module stays pure.
 */

/** The first port the probe reports as taken, in the given order, or undefined when all are free. */
export async function firstBusyPort(ports: readonly number[], isFree: (port: number) => Promise<boolean>): Promise<number | undefined> {
  for (const port of ports) {
    if (!(await isFree(port))) return port;
  }
  return undefined;
}

export function portInUseMessage(port: number): string {
  return `Port ${port} is in use. Stop the process using it (an earlier dev:stack that was killed hard leaves its children running on Windows), then try again.`;
}
