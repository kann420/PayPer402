import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STREAMS_PER_KEY } from './routes/events';
import { createHarness, readFrames, type Harness } from './test-support';

type Frame = { event?: string; data?: unknown; comment?: string };

describe('SSE /v1/events', () => {
  let h: Harness;
  let operator: { operatorId: string; key: string };
  let otherOperator: { operatorId: string; key: string };
  let seller: { sellerId: string; key: string };
  let otherSeller: { sellerId: string; key: string };
  let agentId: string;
  const open: AbortController[] = [];

  async function connect(key: string): Promise<Response> {
    const controller = new AbortController();
    open.push(controller);
    return fetch(`${await h.url()}/v1/events`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
  }

  const dataFrames = (frames: Frame[]) => frames.filter((f) => f.event);

  beforeEach(() => {
    h = createHarness({ sseKeepaliveMs: 25 });
    operator = h.addOperator();
    otherOperator = h.addOperator();
    seller = h.addSeller();
    otherSeller = h.addSeller();
    agentId = h.addAgent(operator.operatorId).agentId;
    h.activateWallet(operator.operatorId);
  });
  afterEach(async () => {
    for (const controller of open.splice(0)) controller.abort();
    await h.close();
  });

  it('delivers events to the right subscribers only, with seller variants', async () => {
    const opStream = await connect(operator.key);
    const otherOpStream = await connect(otherOperator.key);
    const sellerStream = await connect(seller.key);
    const otherSellerStream = await connect(otherSeller.key);
    expect(opStream.headers.get('content-type')).toContain('text/event-stream');

    h.events.emit({
      type: 'commitment.recorded',
      operatorId: operator.operatorId,
      data: { id: 'cmt_1', agentId, payTo: seller.sellerId, path: '/api/x', amount: 5, recordedAt: 1 },
    });
    h.events.emit({ type: 'wallet.updated', operatorId: operator.operatorId, data: { status: 'active' } });
    h.events.emit({ type: 'agent.updated', operatorId: operator.operatorId, data: { id: agentId, status: 'paused' } });
    h.events.emit({ type: 'wallet.updated', operatorId: otherOperator.operatorId, data: { status: 'not_linked' } });

    const opFrames = dataFrames(await readFrames(opStream, (f) => dataFrames(f).length >= 3));
    expect(opFrames).toEqual([
      { event: 'commitment.recorded', data: { id: 'cmt_1', agentId, payTo: seller.sellerId, path: '/api/x', amount: 5, recordedAt: 1 } },
      { event: 'wallet.updated', data: { status: 'active' } },
      { event: 'agent.updated', data: { id: agentId, status: 'paused' } },
    ]);
    const otherFrames = dataFrames(await readFrames(otherOpStream, (f) => dataFrames(f).length >= 1));
    expect(otherFrames).toEqual([{ event: 'wallet.updated', data: { status: 'not_linked' } }]);

    const sellerFrames = dataFrames(await readFrames(sellerStream, (f) => dataFrames(f).length >= 1));
    expect(sellerFrames).toHaveLength(1);
    expect(sellerFrames[0]?.event).toBe('commitment.recorded');
    expect(sellerFrames[0]?.data).toEqual({ id: 'cmt_1', agentRef: expect.stringMatching(/^[0-9a-f]{8}$/), path: '/api/x', amount: 5, recordedAt: 1 });
    expect(JSON.stringify(sellerFrames)).not.toContain(agentId);
    expect(JSON.stringify(sellerFrames)).not.toContain(operator.operatorId);

    // The other seller saw nothing; it only gets keepalives.
    const otherSellerFrames = await readFrames(otherSellerStream, (f) => f.some((x) => x.comment === 'keepalive'));
    expect(dataFrames(otherSellerFrames)).toEqual([]);
  });

  it('sends settlement.updated on claim and resolution; sellers get their own share only', async () => {
    h.addCommitment({ operatorId: operator.operatorId, agentId, payTo: seller.sellerId, amount: 30 });
    h.addCommitment({ operatorId: operator.operatorId, agentId, payTo: otherSeller.sellerId, amount: 12 });
    const opStream = await connect(operator.key);
    const sellerStream = await connect(seller.key);
    const settlement = await h.services.settlements.settleManually(operator.operatorId);

    const opFrames = dataFrames(await readFrames(opStream, (f) => dataFrames(f).length >= 2));
    expect(opFrames).toEqual([
      { event: 'settlement.updated', data: { id: settlement.id, status: 'pending', trigger: 'manual', amount: 42, callsCount: 2 } },
      { event: 'settlement.updated', data: { id: settlement.id, status: 'completed', trigger: 'manual', amount: 42, callsCount: 2 } },
    ]);
    const sellerFrames = dataFrames(await readFrames(sellerStream, (f) => dataFrames(f).length >= 2));
    expect(sellerFrames).toEqual([
      { event: 'settlement.updated', data: { id: settlement.id, status: 'pending', createdAt: settlement.created_at, sellerAmount: 30, sellerCalls: 1 } },
      { event: 'settlement.updated', data: { id: settlement.id, status: 'completed', createdAt: settlement.created_at, sellerAmount: 30, sellerCalls: 1 } },
    ]);
    expect(JSON.stringify(sellerFrames)).not.toContain('42');
  });

  it('sends keepalive comments', async () => {
    const stream = await connect(operator.key);
    const frames = await readFrames(stream, (f) => f.filter((x) => x.comment === 'keepalive').length >= 2);
    expect(frames.filter((x) => x.comment === 'keepalive').length).toBeGreaterThanOrEqual(2);
  });

  it('enforces at most 5 open streams per key and frees a slot on disconnect', async () => {
    const streams: Response[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_KEY; i += 1) streams.push(await connect(operator.key));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    const sixth = await connect(operator.key);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ error: 'too_many_streams' });
    // Another key is unaffected.
    expect((await connect(seller.key)).status).toBe(200);
    // Closing one stream frees a slot.
    await readFrames(streams[0] as Response, (f) => f.length >= 1);
    let reopened: Response | undefined;
    for (let attempt = 0; attempt < 50 && reopened?.status !== 200; attempt += 1) {
      reopened = await connect(operator.key);
    }
    expect(reopened?.status).toBe(200);
  });

  it('requires a key', async () => {
    const res = await fetch(`${await h.url()}/v1/events`);
    expect(res.status).toBe(401);
  });
});
