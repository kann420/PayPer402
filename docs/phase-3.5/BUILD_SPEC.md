# Phase 3.5 build spec: decision layer (Jev spend check)

Implementation plan for Phase 3.5 of [docs/ROADMAP.md](../ROADMAP.md). Draft 2. It **passed
review** in round 2 on 2026-10-16.

- **The behaviour is defined in [docs/spec/decision-layer.md](../spec/decision-layer.md)** (the
  **design spec**, draft 4, passed review). It amends
  [docs/spec/agent.md](../spec/agent.md) (the **Phase 3 design spec**). Section numbers below
  without a file name refer to the design spec.
- **If this file disagrees with a spec, the specs win.** Report the conflict; do not silently
  pick one.
- **Read `CLAUDE.md` (and `CLAUDE.local.md` if present) first.** All conventions apply: English
  only, no secrets in code or logs, no unlisted dependencies, no commit or push.
- **Load the `typesafe:typesafe-ai` skill and read the live TypeSafe docs before writing Jev
  code** (CLAUDE.md). Start at `https://docs.typesafe.ai/llms.txt`, then read the JavaScript SDK
  and Noul pages. This phase writes no Claude code, so the `claude-api` skill is needed only if
  you touch `agent.ts`, which you should not.
- **The Jev spike** (`spikes/jev-check/`, README and script) shows the SDK's behaviour on real
  calls. Read it; do not modify it.

## Goal and exit criteria

Phase 3.5 is done when all of the following hold:

1. **`apps/agent` implements design spec §2–§6 and §8–§10,** tested with:
   - fake `SpendCheck` implementations against a real seller app and the in-memory facilitator
     (the Phase 3 test environments)
   - the Jev implementation through an injected `fetch`, so `npm test` never calls TypeSafe
2. **With the layer off, Phase 3 is unchanged.** Every existing test passes **without editing
   it**; new tests are added beside them.
3. **The evaluation script exists and has been run** (§7, Milestone 5):
   - one recorded `--holdout` run on both models
   - its full output under [Findings](#findings)
   - the final wording, thresholds, modes and pin written into the code constants and into design
     spec §4.5 and §5.1
4. **The agent.md amendments of design spec §9 are applied,** with a change note.
5. **These all pass:** `npm run typecheck`, `npm test`, and the name check in `CLAUDE.local.md`.

The roadmap's "Done when" also needs `npm run demo` against the real sandbox, showing a Jev check
on every paid call. The user runs that; see "Real API use".

## Dependencies

| Package | Where |
|---|---|
| `@typesafe-ai/sdk@0.7.0` (exact) | `apps/agent` `dependencies` |

- **Pin it exactly.** `npm install @typesafe-ai/sdk@0.7.0 -w apps/agent` writes `^0.7.0`; edit it
  back to `0.7.0`. The root lockfile already has 0.7.0 from the spike.
- **Who imports it.** Only `src/jev.ts`, its test, and `scripts/eval-spend-check.ts` import the
  SDK. Every other module stays SDK-agnostic.
- **No other dependency** is added. Use `node:util` `parseArgs` for flags and `node:perf_hooks`
  `performance` for timing.

## SDK facts (checked while writing this spec)

From `node_modules/@typesafe-ai/sdk/dist/index.d.mts` (0.7.0), its `index.mjs`, the API reference
(`https://docs.typesafe.ai/api.md`) and the spike:

- **Construction.** `new TypeSafeClient(config)` **throws** `TypeSafeError` when no key is
  available.
  - An explicit `apiKey` is used as given, **not trimmed**. The SDK trims only environment
    values.
  - The key is resolved with `config.apiKey ?? env`, so an explicit empty string does **not**
    throw. The config never passes one: `env()` returns `undefined` for an empty value.
  - Options used here: `apiKey`, `baseURL`, `logLevel`, `timeout` (per attempt), `retry`
    (`Partial<RetryPolicy>`), `compression`, `fetch`.
- **Request.** `client.systemOne({ state, questions, model }, { signal })` returns an
  `APIPromise`.
  - It **rejects**, never throws, for every failure, including an invalid request.
  - With `compression: false`, the body handed to `fetch` is a JSON **string**:
    `{ state, questions, model }`. The call is `POST <baseURL>/v1/systemone`, with
    `Authorization: Bearer <key>`.
  - `noul(instructions, criteria)` returns `{ type: "noul", instructions, criteria }`.
- **Response.** A 200 JSON body is returned as the result:

  ```json
  { "model": "jev-1.14.0",
    "answers": { "serves_task": { "type": "noul", "noul": 0.78 }, "already_covered": { "type": "noul", "noul": 0.03 } },
    "usage": { "input_tokens": 952, "output_tokens": 20 } }
  ```

  `usage.input_tokens` is `number | null`.
- **Errors.**
  - The classes are `APIError`, with a `status` and the subclasses `BadRequestError` (400),
    `AuthenticationError` (401), `RateLimitError` (429) and `InternalServerError` (5xx). The
    others are `APIConnectionError`, `APITimeoutError` (a subclass of `APIConnectionError`),
    `APIUserAbortError` and `TypeSafeError` (the base class).
  - Their constructors are public, so tests can build instances, for example
    `new APITimeoutError(4000)` and `APIError.fromResponse(503, body, new Headers())`.
- **Timing.**
  - `timeout` applies per attempt; there is no total budget.
  - With `retry: { maxRetries: 0 }` there is exactly one attempt, so `Retry-After` never applies.
  - An aborted `signal` rejects with `APIUserAbortError`. That holds mid-request, mid-body and
    during a backoff, and an abort is never retried.
- **Spike results** (`spikes/jev-check/README.md`):
  - an unknown model id gives 400
  - a bad key gives 401
  - no unhandled rejections on timeouts or aborts
  - median latency about 300 ms

If any of these turns out wrong, stop, record what actually happens under
[Findings](#findings), and adapt within the design spec.

## Layout

New and changed files in `apps/agent`:

```
src/spend-check.ts      types, constants, state builder, policy, judgeSpendCheck, start-up line (SDK-agnostic)
src/jev.ts              createJevSpendCheck, JEV_QUESTIONS, error → note mapping (the only src/ file importing the SDK)
src/registry.ts         CallRegistry and canonicalKey (§3.1)
src/eval-policy.ts      pure eval math: thresholds, modes, loosening, outcomes, matrices (§7.3)
src/payer.ts            amended decide step (§3.2)
src/session.ts          spendCheck option, registry, Jev input, report field
src/events.ts           new refusal codes and notes, check fields, report field
src/tools.ts            check on Jev refusals
src/format.ts           rendering of checks and the summary line
src/config.ts           --no-spend-check and TYPESAFE_API_KEY
src/cli.ts              start-up line and wiring
src/index.ts            new exports
scripts/demo.ts         flag, start-up line and wiring
scripts/spend-check-cases.ts   labelled cases (§7.2)
scripts/eval-spend-check.ts    the evaluation (§7)
package.json            "eval:spend-check": "tsx --env-file-if-exists=../../.env scripts/eval-spend-check.ts"
```

Tests sit next to their modules (`*.test.ts` in `src/`).

`apps/agent/README.md` also changes (Milestone 6).

Outside `apps/agent`, only these files change:

- the root `.env.example`
- the root `package-lock.json`, from adding the SDK to `apps/agent`
- `docs/spec/agent.md`
- `docs/spec/decision-layer.md`
- `docs/ROADMAP.md` (ticks only)

## Milestone 1: spend-check core (`src/spend-check.ts`, `src/registry.ts`)

### Types and constants

- **Types.** `SpendCheckInput`, `SpendCheckResult`, `SpendRule` and `SpendCheckSummary`, exactly
  as in §4.1 and §6, and:

  ```ts
  interface SpendCheck {
    /** The model id shown in the start-up line and the report. */
    readonly model: string;
    check(input: SpendCheckInput, signal: AbortSignal): Promise<SpendCheckResult>;
  }
  type RuleMode = 'enforce' | 'observe';
  interface SpendPolicy {
    notNeededBelow: number;
    coveredAbove: number;
    modes: Record<SpendRule, RuleMode>;
  }
  ```

  `model` on `SpendCheck` is an addition to §4.1. The report (§6) needs "the configured model",
  and the session has no other way to know it. Record it in the design spec's change notes.
- **Constants.**
  - `JEV_MODEL = 'jev-1.14.0'` and `CHECK_DEADLINE_MS = 4000`
  - `DEFAULT_SPEND_POLICY`, from `NOT_NEEDED_BELOW`, `COVERED_ABOVE`, `NOT_NEEDED_MODE` and
    `COVERED_MODE`. The initial values are 0.50, 0.50, `'observe'` and `'observe'` (§5.1).
    Milestone 5 replaces them.
  - `ALLOWED_RANGES = { not_needed: [0.10, 0.50], already_covered: [0.50, 0.95] }` and
    `MARGIN = 0.05`
  - limits: `EARLIER_MAX = 8`, `EXCERPT_CHARS = 600`, `PARAM_CHARS = 600`, `TASK_CHARS = 2000` and
    `STATE_MAX_CHARS = 16000`
- **`class SpendCheckError extends Error { readonly note: string }`.** Implementations reject with
  it to carry a §5.2 note.

### `buildSpendCheckState(input)`

It returns the §4.4 JSON, with the field names exactly as specified.

- **Cuts.**
  - `cut(text, max)`: if `text.length > max`, the result is `text.slice(0, max - 1) + '…'`.
  - Apply it to the task (2,000) and to every string param value (600), in both
    `proposed_call.params` and `earlier_results[].params`. Numbers are unchanged.
  - The excerpt is built by the session (Milestone 3). This function cuts it to 600 again
    without a marker, as a guard.
- **Size cap.** While `earlier_results.length > 0` and `JSON.stringify(state).length >
  STATE_MAX_CHARS`, drop `earlier_results[0]`.
  - The loop stops when no earlier results are left, even if the state is still over the cap.
  - That is unreachable with the catalog limits (about 7,300 characters with no earlier
    results), but the guard is required.
- **The input is never mutated.**

### `applySpendPolicy(result, policy)`

It returns `{ outcome: 'pass' } | { outcome: 'block'; rule } | { outcome: 'flag'; rule }`. Its
order and its strict comparisons follow §5.1:

1. `not_needed` matches when `servesTask < notNeededBelow`; `already_covered` matches when
   `alreadyCovered > coveredAbove`.
2. The first matching rule in `enforce` mode blocks, checking `not_needed` first.
3. Otherwise, the first matching rule in `observe` mode flags, checking `not_needed` first.
4. Otherwise, the check passes.

### `judgeSpendCheck(checker, input, deadlineMs)`

This is the only way the payer and the eval call a checker. It implements §4.2:

- **Deadline.** It creates `signal = AbortSignal.timeout(deadlineMs)` and starts
  `performance.now()`.
- **Calling `check`.** It calls `checker.check(input, signal)` inside `try`, so a synchronous
  throw becomes a rejected promise. It attaches `.catch(() => undefined)` to that promise at
  once, so a late rejection is never unhandled.
- **The race.** It races the promise against a deadline promise that rejects with a private
  sentinel when `signal` aborts. The deadline promise also gets a no-op `catch`.
- **Result:**
  - `{ ok: true, result, latencyMs }`, or
  - `{ ok: false, note, latencyMs }`. `note` is "timed out" for the sentinel, `err.note` for a
    `SpendCheckError`, and "unexpected error" for anything else.
  - A resolved result whose `servesTask` or `alreadyCovered` is not a finite number from 0 to 1
    is `{ ok: false, note: 'unexpected error' }`. This guards every implementation.
- **`latencyMs`** is `Math.round(performance.now() - start)`, measured in every case.

### `describeDecisionLayer(state)`

It returns the §2 start-up line, where `state` is `{ on: true; model; policy } | { on: false;
reason }`:

- "Decision layer: Jev (jev-1.14.0) on"
- the same with ", observe-only: not_needed" when that rule observes. With both rules observing,
  it ends ", observe-only: not_needed, already_covered", in that order.
- "Decision layer: off (<reason>)"

### `src/registry.ts`

- **`canonicalKey(serviceId, params)`** is `serviceId + '\n' + JSON.stringify(sortedParams)`.
  Params are flat (string or number values), so sorting the top-level keys is enough.
- **`class CallRegistry`**, with one record per call that reached the reservation (§3.1):
  - `open(callId, serviceId, key)`: creates an `in_flight` record
  - `paid(callId)`, `uncertain(callId)`, `closed(callId, jevRefusal?)`: the state transitions
  - `setData(callId, data)`: sets the response data of a `paid` record. When more than
    `EARLIER_MAX` paid records hold data, it drops the data of the oldest one.
  - `lookup(key)` returns one of:
    - `{ kind: 'repeat'; record }` for a record closed with a `jevRefusal`
    - `{ kind: 'duplicate'; record }` for an `in_flight`, `paid` or `uncertain` record
    - `undefined`

    `repeat` wins when both exist. The record is the most recent matching one.
  - `earlier()`: the `paid` records, oldest first, the last `EARLIER_MAX` of them, each with its
    `data` (possibly `undefined`, for example while the body is still being read)
  - A transition on an unknown `callId`, or out of order, throws. That is a programming error,
    and the tests prove it never happens.
- `jevRefusal` is `{ code: 'not_needed' | 'already_covered'; check: SpendCheckSummary }`.

### Tests (`spend-check.test.ts`, `registry.test.ts`)

- **`cut` and the state:**
  - a 600-character value is unchanged
  - a 601-character value becomes 599 characters plus "…" (600 in total)
  - the task is cut at 2,000 the same way
  - numbers pass unchanged
  - the field names match §4.4 exactly (snapshot the JSON of one case)
- **The state cap:** a state over 16,000 characters drops the oldest earlier results until it
  fits. One with no earlier results is never dropped below them.
- **`applySpendPolicy`:**
  - the boundaries: `servesTask` equal to the threshold does not match; `alreadyCovered` equal to
    the threshold does not match
  - all four mode combinations
  - both rules matching under each mode combination, including the `not_needed`-first order
    for block and for flag
- **`judgeSpendCheck`:**
  - a resolving checker
  - a `SpendCheckError` rejection (its note)
  - a plain `Error` rejection ("unexpected error")
  - a synchronous throw ("unexpected error")
  - a checker that never settles, with `deadlineMs: 30`: "timed out", and `latencyMs` of 30 or
    more
  - a checker that resolves after the deadline: still "timed out", with no unhandled rejection
    or later effect. Vitest fails on unhandled rejections, so keep the test alive past the late
    settlement.
  - an out-of-range answer (1.2, `NaN`, a missing number): "unexpected error"
  - the signal passed to `check` aborts at the deadline
- **`describeDecisionLayer`:** every variant.
- **`canonicalKey`:**
  - key order does not matter
  - `1` and `"1"` give different keys
  - a different `serviceId` gives a different key
- **The registry:**
  - every transition
  - `lookup` precedence (`repeat` over `duplicate`)
  - `closed` without `jevRefusal` gives no match
  - a `failed`/`charged: "no"` path (`closed`) gives no match
  - `setData` drops the data of the oldest paid record beyond 8
  - `earlier()` order and cap
  - an out-of-order transition throws

## Milestone 2: Jev implementation (`src/jev.ts`)

### `createJevSpendCheck({ apiKey, fetch?, model = JEV_MODEL })`

- **Client.** It constructs the client exactly as in §4.3, so a missing or invalid key makes it
  throw:

  ```ts
  new TypeSafeClient({ apiKey, baseURL: 'https://api.typesafe.ai', logLevel: 'off', timeout: CHECK_DEADLINE_MS,
    retry: { maxRetries: 0 }, compression: false, ...(fetch === undefined ? {} : { fetch }) })
  ```

- **The returned checker.** It returns `{ model, check }`. `check(input, signal)`:
  1. builds the state with `buildSpendCheckState(input)`
  2. calls `client.systemOne({ model, state, questions: JEV_QUESTIONS }, { signal })`
  3. returns `{ model: response.model, servesTask: answers.serves_task.noul, alreadyCovered:
     answers.already_covered.noul }`
  4. rejects with `SpendCheckError(unavailableNote(err))` for any error, and with
     `SpendCheckError('unexpected error')` when an answer is missing, is not a Noul, or is out of
     range
- **`JEV_QUESTIONS`** holds both questions, built with `noul()`, with the §4.5 text byte for byte.
  - The ids are `serves_task` and `already_covered`.
  - Export it for the eval.
- **`unavailableNote(err)`** follows the §5.2 table, in that order:
  1. `APITimeoutError`: "timed out"
  2. `APIUserAbortError`: "timed out"
  3. `APIError`: `service error (HTTP ${status})`
  4. `APIConnectionError`: "connection failed"
  5. anything else: "unexpected error"
- **The key is never logged** and never placed in an error message or a note.

### Tests (`jev.test.ts`, injected `fetch`, no network)

- **Request shape**, with a recording `fetch` that answers the 200 JSON above:
  - `POST https://api.typesafe.ai/v1/systemone`
  - the body is a string that parses to `{ state, questions, model: "jev-1.14.0" }`
  - the state's field names are as in §4.4
  - the question ids, `type: "noul"` and the instruction and criteria texts equal the §4.5 text
  - `authorization` is `Bearer test-key`
- **No environment effect.**
  - Set `TYPESAFE_BASE_URL=https://example.invalid`, `TYPESAFE_DEFAULT_MODEL=jev-1.13.0` and
    `TYPESAFE_LOG_LEVEL=debug` for the test, and spy on `console`.
  - The request still goes to `api.typesafe.ai` with `jev-1.14.0`, and nothing is logged.
  - Restore the environment afterwards.
- **`model` option.** `createJevSpendCheck({ apiKey, fetch, model: 'jev-1.13.0' })` sends
  `jev-1.13.0`, and its `model` property says so.
- **Result mapping:** `model` comes from the response; the two numbers map correctly.
- **Malformed answers** reject with "unexpected error":
  - `answers.serves_task` missing
  - `type: "choice"`
  - `noul: 1.2`
  - `noul: "0.5"`
- **HTTP errors, one attempt each** (assert `fetch` was called once):
  - 400 gives "service error (HTTP 400)"
  - 401 gives "service error (HTTP 401)"
  - 429 with `retry-after: 30` gives "service error (HTTP 429)", without waiting
  - 503 gives "service error (HTTP 503)"
- **Connection and abort:**
  - a `fetch` that throws `TypeError` gives "connection failed"
  - a `fetch` that honours the signal, called with an already-aborted signal and with
    `AbortSignal.timeout(30)`, gives "timed out"
- **`unavailableNote`** with constructed instances of each class, including `APITimeoutError`
  checked before `APIConnectionError`.
- **No construction failure test here.** A constructor throw is handled by `setupDecisionLayer`
  and tested there, with a throwing factory (Milestone 4).

## Milestone 3: registry in the payer and the session

### Session (`src/session.ts`)

- **New option.** `OpenSessionOptions.spendCheck?: { checker: SpendCheck; task: string; policy?:
  SpendPolicy; deadlineMs?: number }`.
  - `policy` defaults to `DEFAULT_SPEND_POLICY`, and `deadlineMs` to `CHECK_DEADLINE_MS`.
  - Both are **test seams**. The CLI and the demo never set them. Design spec §9 names only
    `checker` and `task`; record the seams in the agent.md change note.
- **With `spendCheck`**, the session creates one `CallRegistry`. It passes the registry, the
  checker, the policy, the deadline and an `input(call)` builder to `runPaidCall` through
  `PaidCallContext`. All of these are optional fields, absent when the layer is off.
- **`input(call)`** returns `{ task, call: { serviceName, serviceDescription, params }, earlier
  }`.
  - `earlier` comes from `registry.earlier()`, mapped to `{ serviceName, params, resultExcerpt
    }`.
  - `resultExcerpt` is `''` when `data` is `undefined`. Otherwise it is `JSON.stringify(data)`
    cut at 600 characters without a marker; a string `data` is stringified the same way.
  - `serviceName` comes from the catalog.
  - The model's `reason` is never part of the input.
- **The report** gains `decisionLayer` only when `spendCheck` was given:
  - `model` is `checker.model`, and `modes` is `policy.modes`.
  - The counts are counted from `session.events`:
    - `passed`, `flagged` and `unavailable`: `decided` events by `check.status`
    - `blocked`: `refused` events with `check.status === 'blocked'`, repeats included

### Payer (`src/payer.ts`), design spec §3.2

- **Settlement helpers.** Inside `runPaidCall`, define local helpers `commit`, `release` and
  `markUncertain`. Each calls the `Budget` method and, when a registry is present, the matching
  registry transition. Every existing call site uses them.
  - With no registry, they are exactly the Phase 3 calls, so behaviour is unchanged.
  - **`paidOutcome` gets the `commit` helper** as a parameter, in place of calling
    `ctx.budget.commit` directly (payer.ts line 258). The helper makes the only `registry.paid`
    transition, so the record moves once there too. `paidOutcome` then calls `registry.setData`
    after `readBody`, when a registry is present.
- **Step 4, in one synchronous block** (no `await` until the judge):
  1. Run the existing `price_changed` and `over_per_call_limit` checks.
  2. If a registry is present, look up the key:
     - **`repeat`:** emit `refused` with the first block's code and note, `by: "agent"`, and
       `detail: "Same as <callId>"`. Its `check` is the stored check plus `repeatOf: <callId>`.
       Return the refusal outcome with `check` (below). Nothing is reserved, and the checker is
       not called.
     - **`duplicate`:** emit `refused` with `duplicate_call`, `by: "agent"`, and `detail`
       "Same as <callId> (paid)", "(outcome unknown)" or "(in progress)". Nothing is reserved.
  3. Reserve, as now (`over_budget` on failure). If a registry is present, call
     `registry.open(callId, serviceId, key)`.
  4. **Layer off:** emit `decided` exactly as now, and continue to step 5.
- **Judge (layer on).**
  1. `await judgeSpendCheck(checker, input(call), deadlineMs)`.
  2. A failure gives `check = { status: 'unavailable', note, latencyMs }`.
  3. A result goes through `applySpendPolicy(result, policy)`:
     - **block:** `check = { status: 'blocked', model, servesTask, alreadyCovered, latencyMs }`.
       Call the `release` helper with the Jev refusal. It releases the budget and calls
       `registry.closed(callId, { code: rule, check })`, so the record moves once. Emit
       `refused` with `code: rule`, `by: "agent"` and `check`, and return the refusal
       outcome.
     - **flag:** `check = { status: 'flagged', …, wouldRefuse: rule }`
     - **pass:** `check = { status: 'passed', … }`
  4. For pass, flag and unavailable, emit `decided` with the Phase 3 fields plus `check`, then
     continue with step 5 unchanged.
- **The refusal outcome.** `CallOutcome`'s failure branch gains an optional `check?: {
  servesTask: number; alreadyCovered: number }`. It is set only for Jev refusals and their
  repeats.

### Tests (`decision-layer.test.ts`, with `startDemoEnv` / `startCustomEnv` and a fake `SpendCheck`)

Use a scriptable fake: `fakeSpendCheck(answer: (input, signal) => Promise<SpendCheckResult>)`. It
records every input and call count, and its `model` is `'jev-test'`. Use an all-`enforce` policy
unless a test says otherwise.

- **Layer off.** A happy-path call has no `check` on any event, and `decided` comes right after
  the reservation, as in Phase 3. Existing tests already cover the rest; do not edit them.
- **Pass.**
  - The events are `discovered_price`, then `decided` (with `check.status: 'passed'` and a
    numeric `latencyMs`), then `paid`.
  - The checker's input has the task and the catalog description, and has no `reason`.
- **Earlier results.**
  - After a paid quote, the next input's `earlier` has the quote's `resultExcerpt`, at most 600
    characters.
  - After 9 paid calls (a custom route with a free-form param), `earlier` has 8 entries, and the
    oldest is gone.
- **`not_needed` block.**
  - `refused` with `check.status: 'blocked'`.
  - The reservation is released: `remainingCents` is unchanged.
  - No paid request is made; count requests with `fetchSpy`, so only the probe is seen.
  - The tool result JSON carries `code` and `check`.
  - A later, different call proceeds: the refusal is not blocking.
- **`already_covered` block,** the same checks.
- **Observe mode** (an explicit all-`observe` policy, with answers that match a rule): `decided`
  with `status: 'flagged'` and `wouldRefuse`, then `paid`.
- **No test depends on `DEFAULT_SPEND_POLICY`'s values.** Milestone 5 changes them. Tests pass an
  explicit policy, or derive what they expect from the constant.
- **A mixed policy:** `not_needed` observing and `already_covered` enforced, with both rules
  matching, blocks as `already_covered`.
- **Repeat.**
  - After a block, the same service and params give the same code, `detail: "Same as call_1"`,
    and `check` equal to the first one plus `repeatOf`.
  - The checker is not called again, and nothing is reserved.
  - Changed params are judged anew.
- **Duplicates:**
  - **paid:** `duplicate_call` with detail "(paid)". The checker is not called.
  - **in flight:** two parallel identical calls, with a checker gated on a promise the test
    resolves. The second gets `duplicate_call` "(in progress)", and the first then pays.
  - **uncertain:** a paid request whose `fetch` throws after sending makes the call uncertain.
    The same call then gets `duplicate_call` "(outcome unknown)".
  - **retry allowed:** a call closed with `charged: "no"` (a 400 after payment) may be repeated.
    It reaches the checker again.
- **Unavailable:**
  - a `SpendCheckError('service error (HTTP 503)')` gives `decided` with `status:
    'unavailable'` and that note, then `paid`
  - a never-settling checker with `deadlineMs: 30` gives "timed out", then `paid`
  - a synchronous throw gives "unexpected error"
- **Budget safety.** 20 parallel distinct calls (a custom route with an `n` param), against a
  checker that waits 20 ms and a budget that fits 7: exactly 7 are paid. `remainingCents` is
  never negative.
- **Report.**
  - `decisionLayer` has the model `'jev-test'`, the policy's modes, and counts equal to the event
    counts.
  - With the layer off, it is absent.
- **JSON.** Every event, and the report, round-trips through `JSON.stringify`/`JSON.parse`
  unchanged.

## Milestone 4: events, tools, format, config, CLI and demo

### Code changes

- **`events.ts`:**
  - `RefusalCode` gains `duplicate_call`, `not_needed` and `already_covered`, with the §6 notes
    in `REFUSAL_NOTES`. `BLOCKING_REFUSALS` is unchanged.
  - `decided` and `refused` gain `check?: SpendCheckSummary`.
  - `SpendReport` gains `decisionLayer?`, with the §6 type.
  - Re-export the types from `spend-check.ts`, so the event contract stays in one import.
- **`tools.ts`:** a refusal outcome with `check` adds `check: { servesTask, alreadyCovered }` to the
  `call_service` error JSON. Nothing else changes.
- **`format.ts`**, the §6 formats exactly: ASCII, ` | ` as the separator, and `toFixed(2)`:
  - `decided` with a check appends:
    - ` | Jev: serves task 0.78, covered 0.03`
    - ` | Jev would refuse (not_needed, serves task 0.12), observe-only`. For `already_covered`,
      the number is `covered 0.91`.
    - ` | Jev unavailable (<note>)`
  - `refused` with a blocked check appends ` | Jev: serves task 0.12` for `not_needed` or
    ` | Jev: covered 0.91` for `already_covered`, plus `, repeat of call_3` for a repeat.
  - `formatReport` appends `Decision layer: Jev (<model>): N passed, N blocked, N flagged, N
    unavailable` when `decisionLayer` is present.
- **`config.ts`:**
  - `parseCliArgs` gains `'no-spend-check': { type: 'boolean' }`.
  - `AgentConfig` gains `decisionLayer: { want: true; apiKey: string } | { want: false; reason:
    '--no-spend-check' | 'no TYPESAFE_API_KEY' }`.
    - `TYPESAFE_API_KEY` is read with the existing `env()` helper, which trims it.
    - The flag wins over a missing key (§2).
  - The MCP server keeps calling `loadAgentConfig(process.env, [])` and ignores the field.
- **`spend-check.ts`:** `setupDecisionLayer(want, factory)`, with `factory` **required** (no
  default value).
  - It returns `{ line, spendCheck?: SpendCheck }`.
  - If the factory throws, it returns the "TypeSafe client setup failed" line and no checker.
  - `cli.ts` and `demo.ts` import `createJevSpendCheck` from `./jev` (or `../src/jev`) and pass
    it in, so `spend-check.ts` never imports `jev.ts` or the SDK.
- **`cli.ts`:**
  - Print the start-up line (`io.out`) before opening the session.
  - Pass `spendCheck: { checker, task: config.task }` when there is a checker. The same
    `config.task` goes to `runAgent`.
  - `CliDeps` gains `spendCheckFactory?` (a test seam).
- **`scripts/demo.ts`:**
  - `parseArgs` gains `--no-spend-check`.
  - The key is read and trimmed the same way. Reuse `config.ts`'s helper; export it if
    needed.
  - Print the start-up line as `   Decision layer: …`, right under step 6's "Agent run" line.
  - Pass `spendCheck` with `args.task`, the same string `runAgent` gets.
- **`index.ts`:** export the new public API:
  - `createJevSpendCheck`, `JEV_MODEL`, `JEV_QUESTIONS`
  - `SpendCheck` and the related types
  - `DEFAULT_SPEND_POLICY`, `applySpendPolicy`, `buildSpendCheckState`, `judgeSpendCheck`
  - `describeDecisionLayer`, `setupDecisionLayer`
- **`.env.example`:** under the Anthropic block, add:

  ```
  # Optional. Enables the agent's decision layer (Jev, TypeSafe). Task text is sent to TypeSafe.
  # TYPESAFE_API_KEY
  ```

### Tests

- **`format.test.ts`:** each new line variant, byte for byte, and the summary line.
- **`cli.test.ts`** (fake Anthropic, demo env, fake factory):
  - **The start-up line, each variant.** The expected "on" line is built with
    `describeDecisionLayer` from `DEFAULT_SPEND_POLICY`, so the test holds after Milestone 5. The
    variants are:
    - on
    - off with `--no-spend-check` (with and without a key)
    - off with no key (unset, and whitespace-only)
    - off when the factory throws
  - **The factory gets the key trimmed.**
  - **With the layer on,** the CLI uses `DEFAULT_SPEND_POLICY` (it has no seam).
    - So the fake checker answers `servesTask: 0.90` and `alreadyCovered: 0.05`. Those pass
      under every policy inside `ALLOWED_RANGES`.
    - Assert `check.status: 'passed'` on each `decided` event, and the summary line with 1 passed
      and 0 of every other count (one paid call).
- **`config.test.ts`** (or the existing config tests file):
  - `--no-spend-check` parsing
  - an unknown flag still fails
- **`tools.test.ts`:** a Jev refusal's tool JSON carries `check`; other refusals do not.
- **MCP:** the existing MCP tests still pass. The MCP server builds its session without
  `spendCheck`, so there is no MCP-specific test. `config.test.ts` checks that `loadAgentConfig(env,
  [])` with a key reports `decisionLayer.want: true`. The MCP entry ignores that field; review
  `mcp.ts` to confirm it is unchanged.

## Milestone 5: evaluation (`src/eval-policy.ts`, `scripts/`)

### Pure math (`src/eval-policy.ts`), design spec §7.3

- **Types.**
  - `Label = 'allow' | SpendRule`
  - `Run = { servesTask: number; alreadyCovered: number }`
  - `CaseRuns = { id; label; holdout; runs: Run[] }`
- **`computePolicy(tuning: CaseRuns[])`** runs steps 2 and 3:
  - `floor2(x) = Math.floor(x * 100 + 1e-9) / 100`, and `ceil2` the same way with `Math.ceil`
    and `- 1e-9`
  - it computes the thresholds, clamps them into `ALLOWED_RANGES`, and sets the modes by the
    in-range rule and the "at least 2 own-label cases caught in all 3 runs" bar
  - it returns the policy plus `minAllowServes`, `maxAllowCovered`, the raw values and the
    catch counts
- **`loosen(policy, tuning, holdout)`** runs step 4.
  - It finds the hold-out allow runs that an **enforced** rule matches.
  - It moves that rule's threshold past the worst such value (`floor2(v − MARGIN)` or
    `ceil2(v + MARGIN)`), clamps it, and re-applies step 3 on `tuning`.
  - It repeats until no enforced rule falsely blocks a hold-out allow run.
  - It returns the final policy and a list of the loosenings.
- **Helpers:**
  - `matches(rule, run, policy)`, `caught(case, policy)` and `falselyBlocked(case, policy)`,
    with the §7.3 terms
  - `outcome(run, policy)` uses `applySpendPolicy`
  - `confusion(cases, policy)` gives rows for the labels and columns for pass,
    `block:not_needed`, `block:already_covered`, `flag:not_needed` and `flag:already_covered`,
    counted per run
- **Tests (`eval-policy.test.ts`):**
  - **the rounding and range edge cases:**
    - `minAllowServes` 0.574 gives a raw 0.52, capped at 0.50 and in range
    - `minAllowServes` 0.12 gives 0.07, clamped to 0.10, so the rule observes
    - `maxAllowCovered` 0.93 gives 0.98, clamped to 0.95, so the rule observes
    - `maxAllowCovered` 0.051 gives 0.11 (rounded up), raised to the 0.50 floor
  - floating-point inputs such as 0.62 − 0.05 round to 0.57, not 0.56
  - the mode bar with 1 and 2 caught cases
  - a cross-rule match that is not a catch
  - loosening that stays in range, loosening that leaves the range (observe), and the step-3
    re-check that turns a rule to observe
  - the confusion matrix counts

### Cases (`scripts/spend-check-cases.ts`), design spec §7.2

- **Shape.** `{ id, label, holdout, why, task, call: { serviceId, params }, earlier: { serviceId,
  params, data }[] }`.
  - Service names and descriptions come from `SERVICES` in `@payper402/demo-seller`. Scripts may
    import it; `src/` must not.
  - The script turns a case into a `SpendCheckInput` with the same excerpt rule as the session.
    Export the excerpt helper from `session.ts` or `spend-check.ts`; do not duplicate it.
- **Frozen data:**
  - `FIXED_AT_MS = Date.UTC(2026, 9, 16, 12, 0, 0)`. Quotes come from `quoteAt(symbol,
    FIXED_AT_MS)`, plus the related news, the source and `simulated: true`, as `app.ts` builds
    them.
  - Articles have `publishedAt: '2026-10-16'`.
  - Newsroom URLs use `http://localhost:4021`.
  - **Summaries and translations** are captured once from the real seller AI, with a throwaway
    command that is not committed: `createClaudeSellerAi(new Anthropic(), 'claude-sonnet-5-5')`,
    one summarize per needed article and one translate per needed text. Paste the texts into the
    file, with a comment naming the date and the model.
- **Counts and hold-out.** Follow the §7.2 minimums:
  - 4 demo-sequence allow cases, at least 6 other allow cases, at least 8 `not_needed` cases,
    and at least 6 `already_covered` cases
  - at least 6 hold-out cases: at least 1 allow case (from the other allow cases) and at least 1
    of each block label
  - the six spike cases, and anything close to them, are `holdout: false`
- **Labels and reasons.** Write every label and its `why` before running anything. Never edit a
  label after seeing results; report one you doubt.

### Script (`scripts/eval-spend-check.ts`), design spec §7.1 and §7.4

- **Flags:**
  - `--holdout` loads and scores the hold-out cases. Without it, they are filtered out before any
    request.
  - `--models` defaults to `jev-1.14.0,jev-1.13.0`.
  - `--repeats` defaults to 3.
- **The client** is `createJevSpendCheck({ apiKey, model })`, one per model, with the trimmed
  `TYPESAFE_API_KEY`. Each run goes through `judgeSpendCheck(checker, input, CHECK_DEADLINE_MS)`,
  so the deadline, the race, the note mapping and the latency are exactly production's.
- **Tokens.** `judgeSpendCheck` does not expose usage. The script also wraps the client's
  `fetch` and reads `usage.input_tokens` from each 200 body, counting `null` separately.
- **Unavailable runs** (§7.1): retry up to 3 extra attempts per case and model.
  - If a case still lacks 3 answered runs, print `INCOMPLETE`, list the cases, record nothing,
    and exit 1.
- **Default mode** (tuning only) prints, per model:
  - one line per case
  - `computePolicy`'s values
  - the outcomes at that computed policy
  - the confusion matrix
  - latency median and p95
  - tokens and cost ($0.042 per million input tokens)
- **`--holdout` mode is the recorded run.** It resolves the reviewer's two notes:
  - **Which tuning runs.** Per model, the policy is computed by `computePolicy` from **this run's
    tuning runs**. The hold-out is scored at it, `loosen` is applied, and everything is printed.
    The tuning runs used by step 4's re-check are therefore this run's tuning runs. The
    configuration frozen before the run is the wording; the thresholds follow mechanically from
    tuning data in the same run, before the hold-out is looked at.
  - **Production settings.** Checks go through `judgeSpendCheck` with `CHECK_DEADLINE_MS`, and
    the latency and the unavailable counts come from it.
  - It ends with the pin decision (§7.3 step 5) and the final policy per model.
- **Header.** Every output starts with:
  - the date and SDK `VERSION`
  - the models and repeats
  - a SHA-256 of the two questions' JSON, so a recorded run can be tied to its wording
- **Exit code:** 0 when complete.

### What the builder does

1. **Write the cases**, with their labels and reasons, before any run.
2. **Run the default mode.** Optionally revise the wording (§7.3 step 1, H2 first), only on
   tuning results. Each revision is a full default-mode run. Keep a short log of the revisions
   and why under Findings.
3. **Run `--holdout` once,** with the default `--models` (both) and `--repeats` (3). §7.3 step 5
   needs both models, and the mode bar needs 3 runs. Paste its full output under Findings.
4. **Apply the outcome:**
   - Set `JEV_MODEL` and the four policy constants to the pinned model's final policy.
   - Write the final wording, thresholds, modes and pin into design spec §4.5 and §5.1, with a
     change note.
   - If the pin switches to `jev-1.13.0`, say why.
5. **Do not run `--holdout` again after a complete recorded run.** An INCOMPLETE run records
   nothing and is repeated (design spec §7.1). If you find a bug in the script after the recorded
   run, stop and report it: fixing it and re-running is the main session's decision.

Expected cost: about $0.01 per full run. Stay under 20 runs in total.

## Milestone 6: docs and spec sync

- **`docs/spec/agent.md`:** apply the design spec §9 amendments, with a "Build notes (Phase 3.5)"
  change note. It mentions:
  - the test seams (`policy`, `deadlineMs`, `spendCheckFactory`)
  - `SpendCheck.model`
- **`docs/spec/decision-layer.md`:**
  - the final values (§4.5, §5.1)
  - a "Build notes" change note: `SpendCheck.model`, the seams, and any deviation
- **`apps/agent/README.md`:** a "Decision layer" section:
  - what it does, in two sentences
  - that `TYPESAFE_API_KEY` enables it, and `--no-spend-check` turns it off
  - **that the task text and bounded seller excerpts are sent to TypeSafe**
  - the CLI line formats
  - `npm run eval:spend-check -w apps/agent [-- --holdout]`
- **`docs/ROADMAP.md`:** tick the Phase 3.5 tasks that landed. Leave the "Done when" items for the
  user, and do not move the "Current phase" marker.

## Real API use

Tests never call TypeSafe, Anthropic or PayPal. The builder MAY:

- **TypeSafe:** run the evaluation (Milestone 5), and at most 5 one-off smoke checks of
  `createJevSpendCheck` against the real API.
- **Anthropic:** capture the seller texts (Milestone 5) with `claude-sonnet-5-5`, at most 20
  calls in total.
- **The demo, once:** run `npm run demo -- --no-settle` with a temporary `DEMO_DATABASE_PATH` and
  `ANTHROPIC_MODEL=claude-sonnet-5-5`.
  - The wallet is not linked in a fresh database, so the first paid call shows one Jev check, is
    refused by the facilitator, and blocks the session.
  - Report the start-up line and the `[decide]` line.
  - If the Anthropic or PayPal sandbox credentials are missing, skip the run and report it.
  - If `DATA_ENCRYPTION_KEY` or `API_KEY_PEPPER` is missing, set throwaway values in the shell
    for that run only.
  - The run creates `demo-agent.key` next to the temporary database. The `*.key` ignore rule
    covers it; delete the temporary directory afterwards.

Never print or commit keys. Do not run `--link`; it needs the user. The user runs the roadmap's
real-sandbox demo.

## Findings

Builder: record anything that differs from "SDK facts" or that surprised you, plus:

- the wording revision log
- the full `--holdout` output
- the final policy
- the pin decision

### Builder findings (2026-10-16)

**SDK facts.** All the facts above held, with two typing details:

- The SDK's `Fetch` type is `(input: string, init?: RequestInit) => Promise<Response>`, not
  `typeof fetch`. `createJevSpendCheck`'s `fetch` option uses the SDK type.
- `state` is typed `{ [key: string]: ContentValue }`, so an `interface` for the state is not
  assignable (no index signature). `SpendCheckState` is a `type` alias for that reason.
- On `jev-1.14.0`, one check timed out at the 4 s deadline in tuning run 1 and one in the
  recorded run (1 of about 70 to 90 attempts each). `jev-1.13.0` had none. The retry rule (§7.1)
  covered both; no case was incomplete. The p95 latency on 1.14 was about 1.4 s.

**Implementation choices (not behaviour changes):**

- `judgeSpendCheck` starts the timer before creating the deadline signal, and registers its
  deadline listener before calling `check`. Otherwise a checker that rejects on abort with its own
  error would win the race against the deadline (found by the "signal aborts at the deadline"
  test), and `latencyMs` could round to 29 for a 30 ms deadline.
- The payer gets the layer as one optional `decisionLayer` field of `PaidCallContext` (registry,
  checker, policy, deadline and `input` builder together), not five separate optional fields, so
  a partial state cannot exist.
- `CallRegistry.earlier()` orders paid records by payment time. The session keeps each call's
  params in a map by `callId`, so `registry.open` keeps the specified signature.
- New tests are in new files (`spend-check`, `registry`, `jev`, `decision-layer`,
  `cli-decision-layer`, `config`, `format`, `tools`, `eval-policy`), so no existing test file was
  edited.
- `config.ts` exports `env`, `parseCliArgs` and a new `decisionLayerWant`, which the demo reuses.
  `spend-check.ts` also exports `cut`, `resultExcerpt` (the excerpt rule shared with the eval
  cases) and `ruleMatches`.

**Real API use.**

| What | Count | Notes |
|---|---|---|
| Anthropic seller-text capture | 8 calls | `claude-sonnet-5-5`, `maxRetries: 0`: 5 summaries, 3 translations |
| TypeSafe evaluation runs | 3 | 2 default-mode runs (tuning only), then 1 `--holdout` run |
| TypeSafe smoke checks | 0 | The default-mode runs exercised the real client |
| Demo (`--no-settle`, temporary database) | 1 | `ANTHROPIC_MODEL=claude-sonnet-5-5`; `RESULT: PASS` |

The `--holdout` path was first exercised offline, with a fake `fetch` through the real client
(an uncommitted scratch harness): the hold-out, retry and INCOMPLETE paths, and the check that
default mode sends no hold-out case.

**Wording revision log.**

1. **Run 1, draft 4 wording (§4.5 as reviewed).** Questions SHA-256 `8467c8d3…`. Separation was
   already clean on both models: no false blocks, 7 of 7 `not_needed` and 6 of 6
   `already_covered` tuning cases caught. Computed `NOT_NEEDED_BELOW` was 0.39 on 1.14 and 0.43 on
   1.13; `COVERED_ABOVE` was 0.50 on both.
   - The weak spot was `demo-1-quote-kc`, the demo's first call. It scored `servesTask`
     0.44–0.52 on 1.14 (0.63–0.74 in the spike, with draft 2 wording), only 0.05 above the
     computed threshold.
   - Gap between the lowest allow and the highest `not_needed`: 0.17 on 1.14 (0.44 vs 0.27), 0.20
     on 1.13 (0.48 vs 0.28).
2. **Revision 1 (run 2).** One sentence was added to the `serves_task` `true` criterion: "A call
   that answers one part of a task with several parts counts." The reason: the demo task asks for
   several things, and each demo call answers one of them. Questions SHA-256 `d3cd4fab…`.
   - Every allow score rose. The lowest allow was 0.73 on 1.14 and 0.80 on 1.13, so the
     `not_needed` threshold caps at 0.50.
   - The gap widened to 0.33 on 1.14 (0.73 vs 0.40) and 0.42 on 1.13 (0.80 vs 0.38).
   - **The cost, stated plainly:** `not_needed` scores also rose. `nn-premium-for-price-only`
     reached 0.40 on 1.14, so the margin on the block side is now about 0.10 below the 0.50
     threshold (it was about 0.12 below 0.39). In the recorded `--holdout` run the highest
     tuning `not_needed` score on 1.14 was 0.41 (`nn-translate-sugar-french-unasked`), a margin
     of about 0.09.
   - The revision was kept for the wider gap and the demo's first call. `already_covered` was not
     changed. H2 was not needed: the repeat into `vi` was caught (0.71–0.78).
   - An intermediate phrasing ("…asks for, or part of it?") was drafted but never run.

**Labels.** No label was changed after a run, and every label and hold-out flag stays as
written. Two hold-out cases are weak (audit round 1), which makes the hold-out result weaker
evidence than its 7 cases suggest:

- `nn-translate-cocoa-spanish-unasked` differs from the tuning case
  `nn-translate-cocoa-german-unasked` only in the target language.
- `cov-resummarize-sugar-other-host` uses a `127.0.0.1` URL, which the real seller would refuse
  with `unsupported_url` (uncharged). Jev still judges whether the information is already in
  hand, so the label stands; but the case tests Jev's reading, not a likely agent path.

**Final policy and pin.**

- `JEV_MODEL = 'jev-1.14.0'` (unchanged), `NOT_NEEDED_BELOW = 0.50`, `NOT_NEEDED_MODE = 'enforce'`,
  `COVERED_ABOVE = 0.50`, `COVERED_MODE = 'enforce'`.
- No loosening. Hold-out catch rate: `not_needed` 3 of 3 and `already_covered` 2 of 2 on both
  models, with no allow run falsely blocked.
- `jev-1.13.0` gave the same policy. The pin stays on 1.14, which enforces both rules.
- With 30 cases (7 hold-out), these numbers are indicative only.
- The start-up line is therefore "Decision layer: Jev (jev-1.14.0) on", with no observe-only
  suffix.

**Demo run (`npm run demo -- --no-settle`, fresh temporary database, wallet not linked):**

```
6. Agent run: budget $1.00, per-call limit $0.10.
   Decision layer: Jev (jev-1.14.0) on
   [decide] call_1 pay $0.02 for Market Quote API: Get current coffee price and news links (left after this: $0.98) | Jev: serves task 0.96, covered 0.01
   [refused] call_1 Market Quote API: The operator has not linked a PayPal account (wallet_not_linked, by facilitator)
   Decision layer: Jev (jev-1.14.0): 1 passed, 0 blocked, 0 flagged, 0 unavailable
RESULT: PASS
```

**Spec conflict (resolved after audit round 1).** Design spec §7.1 says an incomplete eval run "is
repeated later", and step 5 of "What the builder does" said never to run `--holdout` twice. Step 5
now says not to run it again after a *complete* recorded run; an INCOMPLETE run records nothing
and is repeated. The recorded run was complete, so the conflict never arose.

**Full `--holdout` output (the recorded run):**

```
Decision-layer evaluation (--holdout: recorded run)
Date: 2026-10-16T16:11:29.514Z   @typesafe-ai/sdk 0.7.0
Models: jev-1.14.0, jev-1.13.0   Repeats: 3   Deadline: 4000 ms
Questions SHA-256: d3cd4fab47d9f52ef8ca33983034b35e1078b937e4e1de7f208f5c4d8592f9b6
Cases: 23 tuning, 7 hold-out (allow 12, not_needed 10, already_covered 8)
Numbers are indicative only: the case set is small.
   [jev-1.14.0] cov-translate-rains-vi-trailing-space: attempt 3 unavailable (timed out)
[jev-1.14.0] retried attempts: 1
[jev-1.13.0] retried attempts: 0

=== jev-1.14.0
Tuning cases at the computed policy (not_needed < 0.50 (enforce), already_covered > 0.50 (enforce)):
  ✓ demo-1-quote-kc                          allow           serves 0.95-0.96  covered 0.01-0.01  pass,pass,pass
  ✓ demo-2-summarize-top-article             allow           serves 0.94-0.95  covered 0.03-0.03  pass,pass,pass
  ✓ demo-3-translate-summary-vi              allow           serves 0.95-0.96  covered 0.03-0.04  pass,pass,pass
  ✓ demo-4-summarize-second-article          allow           serves 0.94-0.95  covered 0.03-0.04  pass,pass,pass
  ✓ allow-cocoa-price                        allow           serves 0.95-0.96  covered 0.01-0.01  pass,pass,pass
  ✓ allow-translate-paragraph-french         allow           serves 0.97-0.98  covered 0.01-0.01  pass,pass,pass
  ✓ allow-sugar-summary-after-quote          allow           serves 0.93-0.94  covered 0.03-0.03  pass,pass,pass
  ✓ allow-cocoa-quote-for-comparison         allow           serves 0.94-0.95  covered 0.01-0.02  pass,pass,pass
  ✓ allow-translate-roasters-japanese        allow           serves 0.72-0.73  covered 0.02-0.03  pass,pass,pass
  ✓ allow-cotton-quote-after-sugar           allow           serves 0.96-0.96  covered 0.02-0.02  pass,pass,pass
  ✓ nn-cocoa-quote-for-coffee-task           not_needed      serves 0.23-0.24  covered 0.02-0.02  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-sugar-quote-for-coffee-task           not_needed      serves 0.16-0.17  covered 0.02-0.02  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-translate-sugar-french-unasked        not_needed      serves 0.31-0.41  covered 0.03-0.03  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-premium-for-price-only                not_needed      serves 0.27-0.35  covered 0.05-0.06  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-summary-for-price-only                not_needed      serves 0.12-0.17  covered 0.05-0.05  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-quote-for-translate-task              not_needed      serves 0.02-0.02  covered 0.01-0.01  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-translate-cocoa-german-unasked        not_needed      serves 0.12-0.21  covered 0.04-0.05  block:not_needed,block:not_needed,block:not_needed
  ✓ cov-translate-again-vi                   already_covered serves 0.94-0.95  covered 0.76-0.79  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-resummarize-rains-shorter            already_covered serves 0.91-0.92  covered 0.70-0.79  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-translate-paragraph-fr-code          already_covered serves 0.96-0.98  covered 0.86-0.89  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-translate-paragraph-ja-code          already_covered serves 0.97-0.98  covered 0.89-0.92  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-translate-rains-vi-trailing-space    already_covered serves 0.95-0.95  covered 0.94-0.96  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-resummarize-cotton-shorter           already_covered serves 0.93-0.94  covered 0.54-0.61  block:already_covered,block:already_covered,block:already_covered
minAllowServes 0.720   maxAllowCovered 0.040
  not_needed       raw 0.67  computed 0.50  stored 0.50  in range yes  caught 7/7  mode enforce
  already_covered  raw 0.09  computed 0.50  stored 0.50  in range yes  caught 6/6  mode enforce
  tuning                            pass      block:not_needed block:already_covered       flag:not_needed  flag:already_covered
  allow                               30                     0                     0                     0                     0
  not_needed                           0                    21                     0                     0                     0
  already_covered                      0                     0                    18                     0                     0
Hold-out cases at the frozen policy:
  ✓ allow-summarize-cocoa-stocks             allow           serves 0.87-0.91  covered 0.01-0.01  pass,pass,pass
  ✓ allow-premium-sugar                      allow           serves 0.95-0.97  covered 0.01-0.01  pass,pass,pass
  ✓ nn-translate-cocoa-spanish-unasked       not_needed      serves 0.11-0.14  covered 0.03-0.04  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-premium-sugar-for-cotton-task         not_needed      serves 0.01-0.02  covered 0.01-0.01  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-summary-for-greeting-translation      not_needed      serves 0.01-0.01  covered 0.01-0.01  block:not_needed,block:not_needed,block:not_needed
  ✓ cov-resummarize-cocoa-longer             already_covered serves 0.91-0.92  covered 0.96-0.96  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-resummarize-sugar-other-host         already_covered serves 0.92-0.93  covered 0.74-0.77  block:already_covered,block:already_covered,block:already_covered
  hold-out                          pass      block:not_needed block:already_covered       flag:not_needed  flag:already_covered
  allow                                6                     0                     0                     0                     0
  not_needed                           0                     9                     0                     0                     0
  already_covered                      0                     0                     6                     0                     0
Loosening: none (no hold-out allow run falsely blocked).
Hold-out catch rate at the final policy: not_needed 3/3, already_covered 2/2
Final policy: not_needed < 0.50 (enforce), already_covered > 0.50 (enforce)
Latency: median 245 ms, p95 1423 ms (91 attempts)
Tokens: 78495 input over 90 answers (0 without a count), about $0.00330

=== jev-1.13.0
Tuning cases at the computed policy (not_needed < 0.50 (enforce), already_covered > 0.50 (enforce)):
  ✓ demo-1-quote-kc                          allow           serves 0.89-0.90  covered 0.02-0.03  pass,pass,pass
  ✓ demo-2-summarize-top-article             allow           serves 0.89-0.90  covered 0.06-0.06  pass,pass,pass
  ✓ demo-3-translate-summary-vi              allow           serves 0.89-0.90  covered 0.05-0.05  pass,pass,pass
  ✓ demo-4-summarize-second-article          allow           serves 0.90-0.91  covered 0.08-0.08  pass,pass,pass
  ✓ allow-cocoa-price                        allow           serves 0.94-0.94  covered 0.02-0.02  pass,pass,pass
  ✓ allow-translate-paragraph-french         allow           serves 0.97-0.97  covered 0.02-0.02  pass,pass,pass
  ✓ allow-sugar-summary-after-quote          allow           serves 0.91-0.92  covered 0.07-0.07  pass,pass,pass
  ✓ allow-cocoa-quote-for-comparison         allow           serves 0.94-0.95  covered 0.04-0.04  pass,pass,pass
  ✓ allow-translate-roasters-japanese        allow           serves 0.75-0.81  covered 0.05-0.05  pass,pass,pass
  ✓ allow-cotton-quote-after-sugar           allow           serves 0.95-0.95  covered 0.05-0.05  pass,pass,pass
  ✓ nn-cocoa-quote-for-coffee-task           not_needed      serves 0.24-0.33  covered 0.05-0.06  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-sugar-quote-for-coffee-task           not_needed      serves 0.16-0.17  covered 0.05-0.07  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-translate-sugar-french-unasked        not_needed      serves 0.07-0.09  covered 0.05-0.06  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-premium-for-price-only                not_needed      serves 0.33-0.37  covered 0.14-0.16  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-summary-for-price-only                not_needed      serves 0.14-0.16  covered 0.08-0.09  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-quote-for-translate-task              not_needed      serves 0.03-0.03  covered 0.02-0.02  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-translate-cocoa-german-unasked        not_needed      serves 0.03-0.04  covered 0.06-0.07  block:not_needed,block:not_needed,block:not_needed
  ✓ cov-translate-again-vi                   already_covered serves 0.87-0.88  covered 0.76-0.80  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-resummarize-rains-shorter            already_covered serves 0.87-0.89  covered 0.79-0.88  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-translate-paragraph-fr-code          already_covered serves 0.97-0.97  covered 0.93-0.94  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-translate-paragraph-ja-code          already_covered serves 0.97-0.97  covered 0.90-0.93  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-translate-rains-vi-trailing-space    already_covered serves 0.86-0.89  covered 0.93-0.95  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-resummarize-cotton-shorter           already_covered serves 0.90-0.92  covered 0.76-0.80  block:already_covered,block:already_covered,block:already_covered
minAllowServes 0.750   maxAllowCovered 0.080
  not_needed       raw 0.70  computed 0.50  stored 0.50  in range yes  caught 7/7  mode enforce
  already_covered  raw 0.13  computed 0.50  stored 0.50  in range yes  caught 6/6  mode enforce
  tuning                            pass      block:not_needed block:already_covered       flag:not_needed  flag:already_covered
  allow                               30                     0                     0                     0                     0
  not_needed                           0                    21                     0                     0                     0
  already_covered                      0                     0                    18                     0                     0
Hold-out cases at the frozen policy:
  ✓ allow-summarize-cocoa-stocks             allow           serves 0.87-0.89  covered 0.02-0.02  pass,pass,pass
  ✓ allow-premium-sugar                      allow           serves 0.91-0.92  covered 0.02-0.02  pass,pass,pass
  ✓ nn-translate-cocoa-spanish-unasked       not_needed      serves 0.03-0.03  covered 0.06-0.06  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-premium-sugar-for-cotton-task         not_needed      serves 0.02-0.02  covered 0.02-0.02  block:not_needed,block:not_needed,block:not_needed
  ✓ nn-summary-for-greeting-translation      not_needed      serves 0.01-0.02  covered 0.02-0.02  block:not_needed,block:not_needed,block:not_needed
  ✓ cov-resummarize-cocoa-longer             already_covered serves 0.89-0.90  covered 0.96-0.97  block:already_covered,block:already_covered,block:already_covered
  ✓ cov-resummarize-sugar-other-host         already_covered serves 0.89-0.90  covered 0.94-0.94  block:already_covered,block:already_covered,block:already_covered
  hold-out                          pass      block:not_needed block:already_covered       flag:not_needed  flag:already_covered
  allow                                6                     0                     0                     0                     0
  not_needed                           0                     9                     0                     0                     0
  already_covered                      0                     0                     6                     0                     0
Loosening: none (no hold-out allow run falsely blocked).
Hold-out catch rate at the final policy: not_needed 3/3, already_covered 2/2
Final policy: not_needed < 0.50 (enforce), already_covered > 0.50 (enforce)
Latency: median 251 ms, p95 587 ms (90 attempts)
Tokens: 78495 input over 90 answers (0 without a count), about $0.00330

Pin: jev-1.14.0. jev-1.14.0 enforces at least one rule.
Pinned policy: not_needed < 0.50 (enforce), already_covered > 0.50 (enforce)
```

## Working rules for the builder

- **Work on branch `phase-3.5/decision-layer`,** which the main session creates from `main`
  before the build. Do not commit, push, or change git config.
- **Do not touch:**
  - `spikes/`
  - the root `.env`
  - `docs/ui-brief.md`, `docs/ui-design-fixes.md`, `docs/brand/` and the prototype HTML files
  - the "Development process" section of `CLAUDE.md`
  - `apps/facilitator`, `apps/demo-seller` or `packages/*`
  - `src/agent.ts` (the system prompt is a Phase 4 item)
- **Do not edit existing tests.** If one fails, the change broke Phase 3 behaviour: fix the code.
- **After each milestone,** run `npm run typecheck` and `npm test`.
- **If a spec is wrong or impossible somewhere,** stop that part and report it with evidence.
- **Code quality:** no `any` in exported types, no suppressed type errors, and no TODOs in place
  of required behaviour.
- **Run the name check in `CLAUDE.local.md` before you report.** Its patterns also match inside
  longer words.
- **When done, report:**
  - what was built
  - test counts
  - the eval result (final policy and pin)
  - deviations, with reasons
  - findings
  - the real-API runs
  - open questions
