import { describe, expect, it } from 'vitest';
import { firstBusyPort, portInUseMessage } from './ports';

describe('dev:stack port check', () => {
  it('returns the first taken port, in order, and stops probing there', async () => {
    const probed: number[] = [];
    const taken = new Set([4020, 4021]);
    const busy = await firstBusyPort([3000, 4020, 4021], async (port) => {
      probed.push(port);
      return !taken.has(port);
    });
    expect(busy).toBe(4020);
    expect(probed).toEqual([3000, 4020]);
  });

  it('returns undefined when every port is free', async () => {
    expect(await firstBusyPort([3000, 4020, 4021], async () => true)).toBeUndefined();
  });

  it('names the port and the likely cause', () => {
    expect(portInUseMessage(3000)).toBe(
      'Port 3000 is in use. Stop the process using it (an earlier dev:stack that was killed hard leaves its children running on Windows), then try again.',
    );
  });
});
