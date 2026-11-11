/**
 * Jev spike: checks the TypeSafe JavaScript SDK (0.7.0) and the Jev models against what the
 * decision-layer spec relies on, before Phase 3.5 is specced for build.
 *
 *   npm run spike -w spikes/jev-check                  offline and online checks
 *   npm run spike -w spikes/jev-check -- --offline     offline checks only (no key, no network)
 *   npm run spike -w spikes/jev-check -- --repeats 5   repeat each demo case 5 times per model
 *
 * Online checks need TYPESAFE_API_KEY in the root .env. The key is never printed.
 */
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  VERSION,
  noul,
  type Fetch,
  type TypeSafeClientConfig,
} from '@typesafe-ai/sdk';
import { ARTICLES, DEMO_SOURCE, SERVICES, quoteAt, type ServiceDef } from '@payper402/agent/eval-fixtures';

// ---------------------------------------------------------------------------------------------
// Spec constants (decision-layer.md §4 and §5, draft 1)
// ---------------------------------------------------------------------------------------------

const MODELS = ['jev-1.14.0', 'jev-1.13.0'] as const;
const ALIASES = ['jev-latest', 'jev-preview'] as const;
const NOT_NEEDED_BELOW = 0.2;
const COVERED_ABOVE = 0.85;
const EXCERPT_CHARS = 600;
const PRICE_PER_TOKEN_USD = 0.042 / 1_000_000;
const SPEC_CLIENT: TypeSafeClientConfig = { logLevel: 'off', timeout: 4000, retry: { maxRetries: 1 } };

/** The default demo task, copied from apps/agent/src/config.ts (DEFAULT_TASK). */
const DEMO_TASK = "Brief me on today's coffee market: current price, top news, and a summary in Vietnamese.";
/** Placeholder seller origin for newsroom links; only the link text reaches Jev. */
const SELLER_ORIGIN = 'http://localhost:4021';

const QUESTIONS = {
  serves_task: noul('Does the service in `proposed_call` return information that the `task` asks for?', {
    true: 'The task asks for the kind of information this service returns, given its description and params.',
    false: 'The task does not ask for the kind of information this service returns.',
  }),
  already_covered: noul('Do the `earlier_results` already contain the result that `proposed_call` would return?', {
    true: 'An earlier result already holds the same information in the same language and form, so the call would repeat it.',
    false:
      'No earlier result holds it, or the call would produce a new form of it, such as a translation into a language not yet present or a summary of a page not yet summarized, or there are no earlier results.',
  }),
};

// ---------------------------------------------------------------------------------------------
// State (spec §4)
// ---------------------------------------------------------------------------------------------

type Params = Record<string, string | number>;
interface Earlier {
  serviceName: string;
  params: Params;
  resultExcerpt: string;
}
interface Call {
  serviceName: string;
  serviceDescription: string;
  params: Params;
}

function service(id: string): ServiceDef {
  const found = SERVICES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown service ${id}`);
  return found;
}

function call(id: string, params: Params): Call {
  const s = service(id);
  return { serviceName: s.name, serviceDescription: s.description, params };
}

function earlier(id: string, params: Params, data: unknown): Earlier {
  return { serviceName: service(id).name, params, resultExcerpt: JSON.stringify(data).slice(0, EXCERPT_CHARS) };
}

function buildState(task: string, proposed: Call, before: Earlier[]) {
  return {
    task,
    proposed_call: { service: proposed.serviceName, description: proposed.serviceDescription, params: proposed.params },
    earlier_results: before.map((e) => ({ service: e.serviceName, params: e.params, result_excerpt: e.resultExcerpt })),
  };
}

// ---------------------------------------------------------------------------------------------
// Demo-sequence data. Quotes and articles are the seller's real fixtures; the summaries and the
// translation stand in for the seller's Claude output, which varies from run to run.
// ---------------------------------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const coffee = ARTICLES.filter((a) => a.topic === 'coffee');
const [rains, roasters] = coffee;
if (!rains || !roasters) throw new Error('expected at least two coffee articles in the seller fixtures');
const newsUrl = (slug: string) => `${SELLER_ORIGIN}/news/${slug}`;

const quoteResult = {
  ...quoteAt('KC', Date.now()),
  relatedNews: coffee.slice(0, 3).map((a) => ({ title: a.title, url: newsUrl(a.slug), publishedAt: today })),
  source: DEMO_SOURCE,
  simulated: true,
};

const rainsSummary =
  'Late rains in the main arabica highlands have slowed the start of the coffee harvest, delaying first deliveries to mills by about ten days. ' +
  'Early lots look good in quality but volumes trail last season. Traders say the delay helped futures hold firm despite cooler roaster demand, ' +
  'and drier weather next week could let picking catch up before the quarter ends.';
const rainsSummaryResult = { url: newsUrl(rains.slug), title: rains.title, summary: rainsSummary, words: rainsSummary.split(/\s+/).length, source: DEMO_SOURCE, simulated: true };

const rainsSummaryVi =
  'Mưa muộn ở các vùng cao nguyên trồng arabica chính đã làm chậm vụ thu hoạch cà phê, khiến các chuyến giao hàng đầu tiên tới nhà máy trễ khoảng mười ngày. ' +
  'Chất lượng các lô đầu vụ tốt nhưng sản lượng thấp hơn vụ trước. Giới giao dịch cho rằng sự chậm trễ giúp giá kỳ hạn giữ vững dù nhu cầu từ các nhà rang xay giảm, ' +
  'và thời tiết khô hơn vào tuần tới có thể giúp việc thu hái bắt kịp trước cuối quý.';
const translationResult = { targetLanguage: 'Vietnamese', translatedText: rainsSummaryVi, characters: rainsSummary.length };

const quoteParams = { symbol: 'KC' };
const rainsParams = { url: newsUrl(rains.slug) };
const translateParams = { text: rainsSummary, targetLanguage: 'Vietnamese' };

const afterQuote = [earlier('quote', quoteParams, quoteResult)];
const afterSummary = [...afterQuote, earlier('summarize', rainsParams, rainsSummaryResult)];
const afterTranslation = [...afterSummary, earlier('translate', translateParams, translationResult)];

type Expect = 'pass' | 'not_needed' | 'already_covered';
interface Case {
  id: string;
  kind: 'must-allow' | 'sanity';
  expect: Expect;
  call: Call;
  earlier: Earlier[];
}

const CASES: Case[] = [
  { id: 'demo-1-quote-kc', kind: 'must-allow', expect: 'pass', call: call('quote', quoteParams), earlier: [] },
  { id: 'demo-2-summarize-top-article', kind: 'must-allow', expect: 'pass', call: call('summarize', rainsParams), earlier: afterQuote },
  { id: 'demo-3-translate-summary-vi', kind: 'must-allow', expect: 'pass', call: call('translate', translateParams), earlier: afterSummary },
  { id: 'demo-4-summarize-second-article', kind: 'must-allow', expect: 'pass', call: call('summarize', { url: newsUrl(roasters.slug) }), earlier: afterTranslation },
  // Two probes only, to see that the probabilities move at all. Not the labelled eval set (spec §7).
  { id: 'sanity-cocoa-quote', kind: 'sanity', expect: 'not_needed', call: call('quote', { symbol: 'CC' }), earlier: afterQuote },
  { id: 'sanity-translate-again-vi', kind: 'sanity', expect: 'already_covered', call: call('translate', { text: rainsSummary, targetLanguage: 'vi' }), earlier: afterTranslation },
];

function decide(servesTask: number, alreadyCovered: number): Expect {
  if (servesTask < NOT_NEEDED_BELOW) return 'not_needed';
  if (alreadyCovered > COVERED_ABOVE) return 'already_covered';
  return 'pass';
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(errorKind(reason));
});

function errorKind(err: unknown): string {
  if (err instanceof APITimeoutError) return `APITimeoutError (timeoutMs ${err.timeoutMs})`;
  if (err instanceof APIConnectionError) return 'APIConnectionError';
  if (err instanceof APIUserAbortError) return 'APIUserAbortError';
  if (err instanceof APIError) return `${err.constructor.name} (HTTP ${err.status})`;
  if (err instanceof TypeSafeError) return `TypeSafeError: ${err.message.slice(0, 140)}`;
  if (err instanceof Error) return `non-SDK ${err.name}: ${err.message.slice(0, 140)}`;
  return `non-SDK ${typeof err}`;
}

/** The fail-open note the spec (§5) would derive, or "UNMAPPED" when the spec has no case for it. */
function specNote(err: unknown): string {
  if (err instanceof APITimeoutError) return 'timed out';
  if (err instanceof APIError) return `service error (HTTP ${err.status})`;
  if (err instanceof APIConnectionError) return 'connection failed';
  return 'UNMAPPED';
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - start), value };
  } catch (error) {
    return { ms: Math.round(performance.now() - start), error };
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? NaN;
}

const fmt = (n: number) => n.toFixed(3);
const heading = (title: string) => console.log(`\n=== ${title}`);

/** A fetch that never answers, and rejects only when its signal aborts. */
const hangingFetch: Fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** A fetch whose 200 response sends half a JSON body and then stalls. */
const stallingBodyFetch: Fetch = async () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"jev-1.14.0","answers":'));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const OFFLINE: TypeSafeClientConfig = { apiKey: 'spike-offline-placeholder', logLevel: 'off' };
const demoState = buildState(DEMO_TASK, CASES[2]!.call, CASES[2]!.earlier);

// ---------------------------------------------------------------------------------------------
// Offline checks
// ---------------------------------------------------------------------------------------------

async function offlineChecks(): Promise<void> {
  heading('O1. SDK version');
  console.log(`VERSION = ${VERSION}`);

  heading('O2. Missing key: does the constructor throw synchronously?');
  const saved = process.env['TYPESAFE_API_KEY'];
  delete process.env['TYPESAFE_API_KEY'];
  try {
    new TypeSafeClient({ logLevel: 'off' });
    console.log('constructor did NOT throw');
  } catch (err) {
    console.log(`constructor threw: ${errorKind(err)}`);
  } finally {
    if (saved !== undefined) process.env['TYPESAFE_API_KEY'] = saved;
  }

  heading('O3. Invalid request: sync throw or rejected promise?');
  {
    const client = new TypeSafeClient({ ...OFFLINE, fetch: hangingFetch });
    let promise: Promise<unknown> | undefined;
    try {
      promise = client.systemOne({ state: { a: 1 }, questions: {} });
    } catch (err) {
      console.log(`systemOne threw synchronously: ${errorKind(err)}`);
    }
    if (promise) {
      const outcome = await timed(() => promise);
      console.log(outcome.error ? `promise rejected: ${errorKind(outcome.error)}` : 'promise resolved (unexpected)');
    }
  }

  heading('O4. Worst-case duration: per-attempt timeout, no total budget');
  for (const [label, config, signalMs] of [
    ['timeout 300, maxRetries 0', { timeout: 300, retry: { maxRetries: 0 } }, undefined],
    ['timeout 300, maxRetries 1', { timeout: 300, retry: { maxRetries: 1 } }, undefined],
    ['timeout 300, default retries (2)', { timeout: 300 }, undefined],
    ['timeout 4000, maxRetries 1, AbortSignal.timeout(500)', { timeout: 4000, retry: { maxRetries: 1 } }, 500],
  ] as const) {
    const client = new TypeSafeClient({ ...OFFLINE, ...config, fetch: hangingFetch });
    const options = signalMs === undefined ? {} : { signal: AbortSignal.timeout(signalMs) };
    const outcome = await timed(() => client.systemOne({ state: demoState, questions: QUESTIONS, model: MODELS[0] }, options));
    console.log(`${label}: ${outcome.ms} ms -> ${errorKind(outcome.error)} -> spec note "${specNote(outcome.error)}"`);
  }

  heading('O5. Response body stalls mid-way (0.7.0 fix for unhandled rejections)');
  {
    const client = new TypeSafeClient({ ...OFFLINE, timeout: 300, retry: { maxRetries: 0 }, fetch: stallingBodyFetch });
    const outcome = await timed(() => client.systemOne({ state: demoState, questions: QUESTIONS, model: MODELS[0] }));
    console.log(`stalled body: ${outcome.ms} ms -> ${errorKind(outcome.error)} -> spec note "${specNote(outcome.error)}"`);
    const controller = new AbortController();
    const aborting = new TypeSafeClient({ ...OFFLINE, timeout: 4000, retry: { maxRetries: 0 }, fetch: stallingBodyFetch });
    setTimeout(() => controller.abort(), 150);
    const aborted = await timed(() => aborting.systemOne({ state: demoState, questions: QUESTIONS, model: MODELS[0] }, { signal: controller.signal }));
    console.log(`caller abort mid-body: ${aborted.ms} ms -> ${errorKind(aborted.error)} -> spec note "${specNote(aborted.error)}"`);
  }
}

// ---------------------------------------------------------------------------------------------
// Online checks
// ---------------------------------------------------------------------------------------------

interface Recorded {
  encoding: string | null;
  bodyType: string;
  bytes: number;
  json?: unknown;
}

async function bodyBytes(body: unknown): Promise<Uint8Array | undefined> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return undefined;
}

/** Records what the SDK hands to fetch, then forwards the request unchanged. */
function recordingFetch(log: Recorded[]): Fetch {
  return async (input, init) => {
    const body = init?.body;
    const encoding = new Headers(init?.headers).get('content-encoding');
    const bytes = await bodyBytes(body);
    const entry: Recorded = { encoding, bodyType: body == null ? String(body) : body.constructor.name, bytes: bytes?.byteLength ?? -1 };
    if (bytes) {
      try {
        const raw = encoding === 'zstd' ? zstdDecompressSync(bytes) : Buffer.from(bytes);
        entry.json = JSON.parse(raw.toString('utf8'));
      } catch {
        // leave json unset
      }
    }
    log.push(entry);
    return fetch(input, init);
  };
}

function shape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return `[${value.length > 0 ? shape(value[0], depth + 1) : ''}]`;
  if (value && typeof value === 'object') {
    if (depth > 2) return '{…}';
    return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(', ')} }`;
  }
  return typeof value;
}

async function onlineChecks(repeats: number): Promise<void> {
  const client = new TypeSafeClient(SPEC_CLIENT);

  heading('A. GET /v1/models');
  {
    const outcome = await timed(() => client.models.list());
    if (outcome.error) console.log(`models.list failed: ${errorKind(outcome.error)}`);
    else for (const m of outcome.value ?? []) console.log(`${m.name}  (${m.release_date})  ${m.description.slice(0, 90)}`);
  }

  heading('B. Access: which model answers each name?');
  const first = CASES[0]!;
  for (const model of [...MODELS, ...ALIASES]) {
    const outcome = await timed(() => client.systemOne({ state: buildState(DEMO_TASK, first.call, first.earlier), questions: QUESTIONS, model }));
    if (outcome.error) console.log(`${model}: ${errorKind(outcome.error)}`);
    else console.log(`${model}: answered by ${outcome.value!.model}, ${outcome.ms} ms, input_tokens ${outcome.value!.usage.input_tokens}`);
  }

  heading('C. Wire format and compression (state of demo case 3)');
  for (const compression of [undefined, false] as const) {
    const log: Recorded[] = [];
    const recClient = new TypeSafeClient({ ...SPEC_CLIENT, ...(compression === undefined ? {} : { compression }), fetch: recordingFetch(log) });
    const outcome = await timed(() => recClient.systemOne({ state: demoState, questions: QUESTIONS, model: MODELS[0] }));
    const entry = log[0];
    const label = compression === undefined ? 'default compression' : 'compression: false';
    console.log(`${label}: content-encoding ${entry?.encoding ?? 'none'}, body ${entry?.bodyType} ${entry?.bytes} bytes, call ${outcome.error ? errorKind(outcome.error) : 'ok'}`);
    if (entry?.json !== undefined) console.log(`  decoded request shape: ${shape(entry.json)}`);
    else console.log('  request body could not be decoded');
  }

  heading('D. Error classes from the real API');
  {
    const probes: [string, TypeSafeClient, string][] = [
      ['bad key', new TypeSafeClient({ ...SPEC_CLIENT, apiKey: 'spike-invalid-key' }), MODELS[0]],
      ['unknown model', client, 'jev-0.0.0'],
      ['timeout 1 ms, no retry', new TypeSafeClient({ ...SPEC_CLIENT, timeout: 1, retry: { maxRetries: 0 } }), MODELS[0]],
      ['connection refused', new TypeSafeClient({ ...SPEC_CLIENT, baseURL: 'http://127.0.0.1:9', retry: { maxRetries: 0 } }), MODELS[0]],
    ];
    for (const [label, probeClient, model] of probes) {
      const outcome = await timed(() => probeClient.systemOne({ state: demoState, questions: QUESTIONS, model }));
      console.log(`${label}: ${outcome.ms} ms -> ${outcome.error ? errorKind(outcome.error) : `answered by ${outcome.value!.model}`} -> spec note "${outcome.error ? specNote(outcome.error) : '-'}"`);
    }
  }

  heading(`E. Demo-sequence cases, ${repeats} run(s) per model, thresholds ${NOT_NEEDED_BELOW}/${COVERED_ABOVE}`);
  let attempts = 0;
  const countingClient = new TypeSafeClient({
    ...SPEC_CLIENT,
    fetch: (input, init) => {
      attempts++;
      return fetch(input, init);
    },
  });
  const stats = new Map<string, { ms: number[]; tokens: number[]; failures: number; retries: number }>();
  for (const model of MODELS) stats.set(model, { ms: [], tokens: [], failures: 0, retries: 0 });
  for (const c of CASES) {
    for (const model of MODELS) {
      const s = stats.get(model)!;
      const serves: number[] = [];
      const covered: number[] = [];
      const decisions: Expect[] = [];
      const errors: string[] = [];
      const rowMs: number[] = [];
      let rowRetries = 0;
      for (let r = 0; r < repeats; r++) {
        attempts = 0;
        const outcome = await timed(() => countingClient.systemOne({ state: buildState(DEMO_TASK, c.call, c.earlier), questions: QUESTIONS, model }));
        rowRetries += Math.max(0, attempts - 1);
        if (outcome.error || !outcome.value) {
          errors.push(errorKind(outcome.error));
          s.failures++;
          continue;
        }
        const { answers, usage } = outcome.value;
        s.ms.push(outcome.ms);
        rowMs.push(outcome.ms);
        if (usage.input_tokens !== null) s.tokens.push(usage.input_tokens);
        serves.push(answers.serves_task.noul);
        covered.push(answers.already_covered.noul);
        decisions.push(decide(answers.serves_task.noul, answers.already_covered.noul));
      }
      s.retries += rowRetries;
      const range = (v: number[]) => (v.length === 0 ? 'n/a' : v.length === 1 ? fmt(v[0]!) : `${fmt(Math.min(...v))}–${fmt(Math.max(...v))}`);
      const ok = decisions.length > 0 && decisions.every((d) => d === c.expect);
      const mark = c.kind === 'must-allow' ? (ok ? '✓' : '✗ FALSE BLOCK') : ok ? '✓ caught' : '· missed';
      const latency = rowMs.length === 0 ? 'n/a' : `${Math.min(...rowMs)}–${Math.max(...rowMs)} ms`;
      console.log(
        `${c.id.padEnd(32)} ${model}  serves ${range(serves).padEnd(11)} covered ${range(covered).padEnd(11)} -> ${[...new Set(decisions)].join('/') || '-'}  (want ${c.expect}) ${mark}  [${latency}${rowRetries ? `, ${rowRetries} retried` : ''}]${errors.length ? `  errors: ${errors.join(', ')}` : ''}`,
      );
    }
  }

  heading('F. Latency and cost per call (section E calls)');
  for (const [model, s] of stats) {
    if (s.ms.length === 0) {
      console.log(`${model}: no successful calls`);
      continue;
    }
    const meanTokens = s.tokens.reduce((a, b) => a + b, 0) / Math.max(1, s.tokens.length);
    console.log(
      `${model}: n=${s.ms.length}, median ${percentile(s.ms, 50)} ms, p95 ${percentile(s.ms, 95)} ms, max ${Math.max(...s.ms)} ms, ` +
        `mean input ${Math.round(meanTokens)} tokens ≈ $${(meanTokens * PRICE_PER_TOKEN_USD).toFixed(6)} per call, retried attempts ${s.retries}, failures ${s.failures}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { offline: { type: 'boolean', default: false }, repeats: { type: 'string', default: '3' } } });
  const repeats = Number.parseInt(values.repeats, 10);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be an integer from 1 to 20');

  console.log(`Jev spike, SDK ${VERSION}, Node ${process.versions.node}`);
  await offlineChecks();

  const hasKey = (process.env['TYPESAFE_API_KEY'] ?? '').trim() !== '';
  if (values.offline) console.log('\n(--offline: online checks skipped)');
  else if (!hasKey) console.log('\nTYPESAFE_API_KEY is not set in the root .env: online checks skipped');
  else await onlineChecks(repeats);

  await new Promise((resolve) => setTimeout(resolve, 200));
  heading('Unhandled rejections during the run');
  console.log(unhandled.length === 0 ? 'none' : unhandled.join('\n'));
}

main().catch((err) => {
  console.error(`spike failed: ${errorKind(err)}`);
  process.exitCode = 1;
});
