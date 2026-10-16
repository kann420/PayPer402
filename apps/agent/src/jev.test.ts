import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeError,
  type Fetch,
} from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_QUESTIONS, createJevSpendCheck, unavailableNote } from './jev';
import { JEV_MODEL, SpendCheckError, type SpendCheckInput } from './spend-check';

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: unknown;
}

const input: SpendCheckInput = {
  task: 'Brief me on coffee.',
  call: { serviceName: 'Market Quote API', serviceDescription: 'Latest futures price.', params: { symbol: 'KC' } },
  earlier: [{ serviceName: 'Page Summary API', params: { url: 'http://localhost:4021/news/a' }, resultExcerpt: '{"summary":"s"}' }],
};

const okBody = {
  model: 'jev-1.14.0',
  answers: { serves_task: { type: 'noul', noul: 0.78 }, already_covered: { type: 'noul', noul: 0.03 } },
  usage: { input_tokens: 952, output_tokens: 20 },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function recording(answer: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body });
    return answer();
  };
  return { fetch, calls };
}

const signal = () => AbortSignal.timeout(4000);

async function noteOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SpendCheckError) return err.note;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('createJevSpendCheck', () => {
  it('sends one POST to api.typesafe.ai with the state, the questions and the pinned model', async () => {
    const rec = recording(() => json(okBody));
    const checker = createJevSpendCheck({ apiKey: 'test-key', fetch: rec.fetch });
    expect(checker.model).toBe(JEV_MODEL);
    await checker.check(input, signal());
    expect(rec.calls).toHaveLength(1);
    const [call] = rec.calls;
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('authorization')).toBe('Bearer test-key');
    expect(typeof call?.body).toBe('string');
    const body = JSON.parse(call?.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body['model']).toBe('jev-1.14.0');
    expect(body['state']).toEqual({
      task: 'Brief me on coffee.',
      proposed_call: { service: 'Market Quote API', description: 'Latest futures price.', params: { symbol: 'KC' } },
      earlier_results: [{ service: 'Page Summary API', params: { url: 'http://localhost:4021/news/a' }, result_excerpt: '{"summary":"s"}' }],
    });
    expect(body['questions']).toEqual({
      serves_task: {
        type: 'noul',
        instructions: 'Does `proposed_call`, with its `params`, return information that the `task` asks for?',
        criteria: {
          true: 'The task asks for the information this call would return, given the service description and these params. A call that answers one part of a task with several parts counts.',
          false: 'The task does not ask for the information this call would return with these params.',
        },
      },
      already_covered: {
        type: 'noul',
        instructions: 'Do the `earlier_results` already contain the result that `proposed_call` would return?',
        criteria: {
          true: 'An earlier result already holds the same information in the same language and form, so the call would repeat it.',
          false:
            'No earlier result holds it, or the call would produce a new form of it, such as a translation into a language not yet present or a summary of a page not yet summarized, or there are no earlier results.',
        },
      },
    });
    expect(body['questions']).toEqual(JSON.parse(JSON.stringify(JEV_QUESTIONS)));
  });

  describe('environment', () => {
    const names = ['TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_LOG_LEVEL'] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    afterEach(() => {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.restoreAllMocks();
    });

    it('ignores TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL and TYPESAFE_LOG_LEVEL, and logs nothing', async () => {
      process.env['TYPESAFE_BASE_URL'] = 'https://example.invalid';
      process.env['TYPESAFE_DEFAULT_MODEL'] = 'jev-1.13.0';
      process.env['TYPESAFE_LOG_LEVEL'] = 'debug';
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      const rec = recording(() => json(okBody));
      await createJevSpendCheck({ apiKey: 'test-key', fetch: rec.fetch }).check(input, signal());
      const failing = recording(() => json({ error: 'nope' }, 503));
      await noteOf(createJevSpendCheck({ apiKey: 'test-key', fetch: failing.fetch }).check(input, signal()));
      expect(rec.calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(JSON.parse(rec.calls[0]?.body as string)).toMatchObject({ model: 'jev-1.14.0' });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  });

  it('sends the model option and reports it', async () => {
    const rec = recording(() => json({ ...okBody, model: 'jev-1.13.0' }));
    const checker = createJevSpendCheck({ apiKey: 'test-key', fetch: rec.fetch, model: 'jev-1.13.0' });
    expect(checker.model).toBe('jev-1.13.0');
    expect(await checker.check(input, signal())).toEqual({ model: 'jev-1.13.0', servesTask: 0.78, alreadyCovered: 0.03 });
    expect(JSON.parse(rec.calls[0]?.body as string)).toMatchObject({ model: 'jev-1.13.0' });
  });

  it('maps the response: the model comes from the response, and the two Nouls map by id', async () => {
    const rec = recording(() =>
      json({ ...okBody, model: 'jev-1.14.1', answers: { already_covered: { type: 'noul', noul: 0.9 }, serves_task: { type: 'noul', noul: 0.12 } } }),
    );
    expect(await createJevSpendCheck({ apiKey: 'test-key', fetch: rec.fetch }).check(input, signal())).toEqual({
      model: 'jev-1.14.1',
      servesTask: 0.12,
      alreadyCovered: 0.9,
    });
  });

  it.each([
    ['serves_task missing', { already_covered: { type: 'noul', noul: 0.1 } }],
    ['type choice', { serves_task: { type: 'choice', choice: 'a' }, already_covered: { type: 'noul', noul: 0.1 } }],
    ['noul 1.2', { serves_task: { type: 'noul', noul: 1.2 }, already_covered: { type: 'noul', noul: 0.1 } }],
    ['noul "0.5"', { serves_task: { type: 'noul', noul: '0.5' }, already_covered: { type: 'noul', noul: 0.1 } }],
  ])('rejects a malformed answer (%s) with "unexpected error"', async (_label, answers) => {
    const rec = recording(() => json({ ...okBody, answers }));
    expect(await noteOf(createJevSpendCheck({ apiKey: 'test-key', fetch: rec.fetch }).check(input, signal()))).toBe('unexpected error');
  });

  it.each([
    [400, {}],
    [401, {}],
    [429, { 'retry-after': '30' }],
    [503, {}],
  ])('maps HTTP %i to "service error (HTTP %i)" after one attempt', async (status, headers) => {
    const rec = recording(() => json({ error: 'x' }, status, headers));
    const started = Date.now();
    expect(await noteOf(createJevSpendCheck({ apiKey: 'test-key', fetch: rec.fetch }).check(input, signal()))).toBe(`service error (HTTP ${status})`);
    expect(rec.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maps a throwing fetch to "connection failed"', async () => {
    const fetch: Fetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await noteOf(createJevSpendCheck({ apiKey: 'test-key', fetch }).check(input, signal()))).toBe('connection failed');
  });

  it('maps an aborted signal, already aborted or by a timeout, to "timed out"', async () => {
    const hanging: Fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const s = init?.signal;
        if (!s) return;
        if (s.aborted) reject(s.reason);
        else s.addEventListener('abort', () => reject(s.reason), { once: true });
      });
    const checker = createJevSpendCheck({ apiKey: 'test-key', fetch: hanging });
    const aborted = new AbortController();
    aborted.abort();
    expect(await noteOf(checker.check(input, aborted.signal))).toBe('timed out');
    expect(await noteOf(checker.check(input, AbortSignal.timeout(30)))).toBe('timed out');
  });

  it('never puts the key in a note', async () => {
    const rec = recording(() => json({ error: 'bad key test-key-secret' }, 401));
    const note = await noteOf(createJevSpendCheck({ apiKey: 'test-key-secret', fetch: rec.fetch }).check(input, signal()));
    expect(note).not.toContain('test-key-secret');
  });
});

describe('unavailableNote', () => {
  it('follows the design spec §5.2 order', () => {
    const timeout = new APITimeoutError(4000);
    expect(timeout).toBeInstanceOf(APIConnectionError);
    expect(unavailableNote(timeout)).toBe('timed out');
    expect(unavailableNote(new APIUserAbortError())).toBe('timed out');
    expect(unavailableNote(APIError.fromResponse(503, {}, new Headers()))).toBe('service error (HTTP 503)');
    expect(unavailableNote(APIError.fromResponse(400, {}, new Headers()))).toBe('service error (HTTP 400)');
    expect(unavailableNote(new APIError(418, {}, new Headers()))).toBe('service error (HTTP 418)');
    expect(unavailableNote(new APIConnectionError())).toBe('connection failed');
    expect(unavailableNote(new TypeSafeError('other'))).toBe('unexpected error');
    expect(unavailableNote(new Error('plain'))).toBe('unexpected error');
    expect(unavailableNote('string')).toBe('unexpected error');
  });
});
