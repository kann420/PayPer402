# PayPer402 decision layer (Jev spend check): design spec

> Status: draft 4 (2026-10-16), for roadmap Phase 3.5. It **passed review** in round 3 on
> 2026-10-16, and builds on the Jev spike ([spikes/jev-check](../../spikes/jev-check/README.md)).
> The final wording, thresholds, modes and pin from the build's evaluation are in §4.5 and §5.1
> (see the build notes).
> Normative keywords follow RFC 2119.

Phase 3.5 adds an optional **decision layer** to the agent's payment path. Before the agent signs
a payment, a System One model, **Jev** (TypeSafe, `@typesafe-ai/sdk`), gives a calibrated second
opinion on the proposed call:

- does this call return information the task asks for?
- is that information already in this run's earlier results?

Code turns the probabilities into a decision with fixed thresholds. The flow is:

1. The Claude agent proposes a call.
2. Jev judges it.
3. Code decides.
4. PayPal settles.

**Scope guardrail (CLAUDE.md).** This is a supporting feature. It is never the headline, and it
is not an injection defence. The budget, the per-call limit and the facilitator's caps stay the
hard guards; the decision layer only adds a refusal reason that they cannot express.

This spec amends the Phase 3 design spec [agent.md](agent.md) in the places listed in §9.
Implementation details will be in [docs/phase-3.5/BUILD_SPEC.md](../phase-3.5/BUILD_SPEC.md),
written after this spec passes review.

## 1. Scope

In scope:

- a `SpendCheck` interface in `apps/agent`, with a Jev implementation over `@typesafe-ai/sdk`
- a per-session call registry, with an exact-duplicate rule in code
- the decision policy (thresholds and per-rule modes) and fail-open behaviour
- the event, report, CLI and demo changes that show the check
- a labelled evaluation script, run against the real Jev on two model versions. It sets the
  thresholds and modes by a fixed procedure, and confirms the pinned model.

Out of scope:

- the MCP server, which has no task to judge against (§2)
- screening seller responses for prompt injection
- judging prices: numbers stay in code
- Jev anywhere outside the agent's payment path

**Off by default in behaviour.** With the layer disabled, every Phase 3 behaviour, event and test
stays exactly as it is.

## 2. When the layer runs

The layer is **enabled** for a session when all of these hold:

- The session has a **task**. That is true for the CLI agent and the demo command (`runAgent`);
  an MCP session has none. The task given to `openSession({ spendCheck })` is the same string as
  the one given to `runAgent`.
- `TYPESAFE_API_KEY` is set and not empty. The agent config reads it with its existing `env()`
  helper, which trims it, and passes the trimmed value to the client. The SDK does not trim a key
  passed in code.
- It was not switched off with `--no-spend-check` on the CLI or the demo.

The CLI and the demo print one line at start-up:

- "Decision layer: Jev (jev-1.14.0) on". If a rule is in observe mode (§5), the line ends with
  ", observe-only: <rule>[, <rule>]", for example ", observe-only: not_needed".
- "Decision layer: off (<reason>)". The reason is "--no-spend-check", "no TYPESAFE_API_KEY" or
  "TypeSafe client setup failed". When `--no-spend-check` is given, it is the reason even if the
  key is missing.

**Client construction.** The `TypeSafeClient` constructor throws when no key is available (spike
O2). So it is built only after the checks above pass.

- If it throws anyway, the layer is off for the session, with the reason "TypeSafe client setup
  failed".
- The run continues. An unavailable layer must never take the demo down.

## 3. Where it runs in the paid-call flow

### 3.1 Call registry

With the layer enabled, the session keeps a **call registry**. The payer reaches it through
`PaidCallContext`.

- **Record.** One record per paid-call attempt that reaches the reservation step, holding:
  - `callId` and `serviceId`
  - `key`: the canonical key, which is `serviceId` plus the params as canonical JSON with sorted
    keys. "Identical params" means equal keys.
  - `state`: `in_flight`, `paid`, `uncertain` or `closed`
  - `data`: the response data, kept only for `paid` records
  - `jevRefusal?`: the code and check of a Jev block (§5), when the record was closed by one
- **Transitions.** They happen exactly where Phase 3 settles the reservation token:
  - `reserve`, then `in_flight`. This is set in the same synchronous block as the reservation.
  - `commit`, then `paid`
  - `markUncertain`, then `uncertain`
  - `release`, then `closed`
- **Data for Jev.** Only the last 8 `paid` records keep their `data`. Older records keep their
  key and state.

The registry is in memory and lives as long as the session. It is not exposed through events.

### 3.2 Order of the decide step

The layer amends step 4 ("Decide") of [agent.md §4.3](agent.md). Phase 3 audited the rule that
nothing is awaited between the checks and the reservation; this order keeps it. Steps 1 to 3 are
**one synchronous block**:

1. **Price checks**, unchanged from Phase 3: `price_changed` and `over_per_call_limit`.
2. **Registry checks** (code). Look up records with the same key:
   - **Repeat of a Jev block.** If a record with this key was closed by a Jev block, refuse with
     the **same code**, without asking Jev.
     - The refusal's `check` is a copy of the first decision, plus `repeatOf: <its callId>`.
     - Nothing is reserved.
     - This is stable: the task is fixed for the session, and earlier results only grow, so
       asking Jev again would only re-roll a noisy answer (spike E: up to 0.16 between runs).
   - **Duplicate.** Otherwise, if a record with this key is `paid`, `uncertain` or `in_flight`,
     refuse with `duplicate_call` and `by: "agent"`. Nothing is reserved.
     - `detail` is "Same as <callId> (paid)", "(outcome unknown)" or "(in progress)".
     - An uncertain call may have been charged, so paying again risks a double charge.
     - An in-flight duplicate is a parallel call made while the first awaits Jev.
   - A record closed for any other reason does not count, for example a `failed` call with
     `charged: "no"`. The model may retry it.
3. **Reserve**, as in Phase 3 (`over_budget` on failure). On success, add the `in_flight` record.
4. **Judge.** Await the check (§4) while the reservation is held, so parallel calls cannot race
   the budget during the await. The payer bounds the await with its deadline (§4.2).
5. **Apply the policy** (§5):
   - **block:** set the record's `jevRefusal`, release the reservation (the record becomes
     `closed`), and emit `refused` (§6). The tool result is a refusal, as for any other code.
     These refusals are **not blocking**: other calls go through as normal.
   - **pass**, **flag** (observe mode) or **unavailable:** emit `decided` with the check
     attached, then sign and pay as in Phase 3.

- **Where `decided` is emitted.** With the layer on, `decided` is emitted after the Jev await,
  because it carries the check. With the layer off, it stays where Phase 3 emits it.
- **Why the registry rules depend on the layer.** They run only when the layer is enabled, so
  every audited Phase 3 behaviour and test is unchanged with it off. The Phase 3 system prompt
  already tells the model not to repeat calls. Running the duplicate rule without the layer
  would be a Phase 3 change, and that is out of scope here.
- `discovered_price` still comes first; the probe is free and the layer runs after it.

## 4. The Jev check

### 4.1 Interface

```ts
interface SpendCheckInput {
  task: string;
  call: { serviceName: string; serviceDescription: string; params: Record<string, string | number> };
  earlier: { serviceName: string; params: Record<string, string | number>; resultExcerpt: string }[];
}
interface SpendCheckResult {
  model: string;
  servesTask: number;      // Noul probability, 0..1
  alreadyCovered: number;  // Noul probability, 0..1
}
interface SpendCheck {
  readonly model: string;  // the configured model, for the start-up line and the report (build notes)
  check(input: SpendCheckInput, signal: AbortSignal): Promise<SpendCheckResult>;
}
```

**Independence.** The agent's `reason` is **not** part of the input. A second opinion that reads
the first opinion's argument tends to agree with it. Price is not part of the input either:
numbers stay in code.

**`earlier`** lists this session's `paid` records that still hold data (§3.1), oldest first, at
most 8. `resultExcerpt` is the record's response data as compact JSON, cut at 600 characters, or
an empty string when the data is not available.

### 4.2 Deadline (owned by the payer)

The payer, not the implementation, bounds the check, so the bound holds for every `SpendCheck`,
test doubles included.

- `CHECK_DEADLINE_MS = 4000`. The payer creates `AbortSignal.timeout(CHECK_DEADLINE_MS)` and
  passes it to `check`.
- It awaits `check` raced against that signal. If the signal fires first, the check is
  unavailable with the note "timed out", even if the implementation ignores the signal.
- A synchronous throw from `check` is treated as a rejection.
- A settlement that arrives after the deadline is ignored. Its rejection is caught, so it can never
  surface as an unhandled rejection.
- The reservation is therefore held for at most `CHECK_DEADLINE_MS` plus scheduling time.
- **The payer measures `latencyMs`** for every outcome, from the call to `check` until the race
  settles. This includes the deadline case, in which the implementation never returns.

### 4.3 Jev implementation

`createJevSpendCheck({ apiKey, fetch?, model? })`. It makes one
`client.systemOne({ model, state, questions }, { signal })` request, and the two Nouls are
answered in parallel.

- **Pins.**
  - `model` defaults to the constant `JEV_MODEL = "jev-1.14.0"`.
    - That is the build behind `jev-preview` on 2026-10-16. `jev-latest` still pointed to
      `jev-1.13.0`.
    - It is pinned by id so its answers cannot move under the tuned thresholds.
    - The `model` option exists for the evaluation (§7) and the tests. The CLI and the demo never
      set it.
  - The SDK is `@typesafe-ai/sdk` at exactly `0.7.0`.
- **Client.** Every option that has an environment fallback is set explicitly, and the model is
  set per request. So `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_LOG_LEVEL` have
  no effect.

  ```ts
  new TypeSafeClient({
    apiKey,                              // trimmed, from the agent config (§2)
    baseURL: 'https://api.typesafe.ai',
    logLevel: 'off',
    timeout: 4000,                       // one attempt, equal to the payer's deadline
    retry: { maxRetries: 0 },
    compression: false,
    ...(fetch === undefined ? {} : { fetch }),
  })
  ```

- **One attempt, no retry.** The SDK's `timeout` applies per attempt, with no total budget (spike
  O4).
  - A retry inside a 4 s budget could only follow a fast failure: after a cut-off first attempt
    and a backoff of 375 to 500 ms, about 1 s would be left, which is below the measured p95.
  - One 4 s attempt keeps the bound simple and lets slow answers complete. The spike's slowest
    completed call took 2.7 s.
  - The cost is accepted. In the spike, one call in 108 took 4.75 s, most likely because a first
    attempt was cut off at 4 s and a retry answered. Without retries, that check would be
    unavailable, and the call would proceed.
  - With no retries, the SDK never waits on a `Retry-After`, so a 429 surfaces at once as
    "service error (HTTP 429)".
- **Compression off.** The request is about 3 KB of JSON. zstd would save about 1.8 KB. Plain JSON
  lets tests read the request body from an injected `fetch` directly (spike C).

### 4.4 State

The field names are part of the contract:

```json
{
  "task": "<task>",
  "proposed_call": {
    "service": "<serviceName>",
    "description": "<serviceDescription>",
    "params": { "...": "..." }
  },
  "earlier_results": [
    { "service": "<serviceName>", "params": { "...": "..." }, "result_excerpt": "<≤ 600 chars>" }
  ]
}
```

**Bounds.** They limit untrusted text and keep the state small; the Jev 1.13 notes say unrelated
content costs accuracy.

- `result_excerpt` is at most 600 characters. Its field name says it is an excerpt.
- **String param values** in `proposed_call.params` and `earlier_results[].params` are cut at 600
  characters. A param can come from the model and carry seller text, for example the translate
  service's `text`.
  - A value longer than 600 characters becomes its first 599 characters followed by "…", so the
    result is exactly 600 characters.
  - `result_excerpt` is cut at 600 characters without a marker, as before.
- **`task`** is cut at 2,000 characters the same way: the first 1,999 characters followed by
  "…".
- **The serialized state** is at most 16,000 characters. If it is longer, drop the oldest
  `earlier_results` entries until it fits.
  - With the bounds above, the demo catalog's worst case is about 14,000 characters, so nothing
    is dropped.
  - A catalog with many string params can go over the cap, and the drop keeps it within the cap.
  - A typical demo state is about 2.5 KB.

### 4.5 Questions

This is the **final wording**, set by the evaluation (§7.3 step 1) on 2026-10-16. Questions
SHA-256 (of the questions' JSON): `d3cd4fab47d9f52ef8ca33983034b35e1078b937e4e1de7f208f5c4d8592f9b6`.

**Re-evaluation rule.** The recorded policy holds only for the code it was measured on. Any change
to `JEV_QUESTIONS` (wording or criteria), to `buildSpendCheckState` (field names or bounds, §4.4),
or to the four policy constants (§5.1) requires a new recorded `--holdout` run (§7.3), and so does
a change of the pinned model (§8). The SHA-256 above is the check for the wording: every eval run
prints it in its header, and a recorded run counts only if the hash matches the shipped questions.

- `serves_task`. Its instructions and criteria ask about the call with its params (H1). The
  evaluation added one sentence to the `true` criterion, so a call that answers one part of a
  multi-part task counts. With the draft 4 wording, the demo's first call (quote `KC`) scored only
  0.44 to 0.52 on `jev-1.14.0`.

  ```
  noul(
    "Does `proposed_call`, with its `params`, return information that the `task` asks for?",
    {
      true: "The task asks for the information this call would return, given the service description and these params. A call that answers one part of a task with several parts counts.",
      false: "The task does not ask for the information this call would return with these params.",
    },
  )
  ```

- `already_covered`, unchanged from draft 4:

  ```
  noul(
    "Do the `earlier_results` already contain the result that `proposed_call` would return?",
    {
      true: "An earlier result already holds the same information in the same language and form, so the call would repeat it.",
      false: "No earlier result holds it, or the call would produce a new form of it, such as a translation into a language not yet present or a summary of a page not yet summarized, or there are no earlier results.",
    },
  )
  ```

### 4.6 Result

- `servesTask = answers.serves_task.noul` and `alreadyCovered = answers.already_covered.noul`.
  Each MUST be a finite number from 0 to 1. Anything else is a malformed answer (§5).
- `model = response.model`.
- `latencyMs` is not part of the result. The payer measures it (§4.2).

The module exports the state builder, the questions and the policy function (§5), so the
evaluation applies exactly the same code.

## 5. Policy

### 5.1 Rules, thresholds and modes

The policy has two rules. Each has a threshold and a mode, and all four are constants in code:

| Rule | Threshold constant | Allowed range | Matches when | Mode constant |
|---|---|---|---|---|
| `not_needed` | `NOT_NEEDED_BELOW` | 0.10 to 0.50 | `servesTask < NOT_NEEDED_BELOW` | `NOT_NEEDED_MODE` |
| `already_covered` | `COVERED_ABOVE` | 0.50 to 0.95 | `alreadyCovered > COVERED_ABOVE` | `COVERED_MODE` |

- **Ranges are inclusive.** A stored threshold is always inside its range. The procedure (§7.3)
  clamps a computed value into the range, and a rule whose computed value fell outside it is
  set to `"observe"`.
- **Modes.** A mode is `"enforce"` (a match blocks) or `"observe"` (a match only flags).
  - The values are set by the evaluation procedure (§7), never by hand.
  - Before the evaluation, both modes were `"observe"`, and the thresholds were 0.50 for both
    rules.
- **Final values** (the recorded `--holdout` run of 2026-10-16, no loosening):

  | Constant | Value |
  |---|---|
  | `JEV_MODEL` (pin) | `jev-1.14.0`, unchanged: it enforces both rules |
  | `NOT_NEEDED_BELOW` | 0.50 (computed `min(0.50, floor2(0.72 − 0.05))` = 0.50) |
  | `NOT_NEEDED_MODE` | `"enforce"` (7 of 7 tuning cases caught) |
  | `COVERED_ABOVE` | 0.50 (computed `max(0.50, ceil2(0.04 + 0.05))` = 0.50) |
  | `COVERED_MODE` | `"enforce"` (6 of 6 tuning cases caught) |

  - `jev-1.13.0` gave the same policy (minAllowServes 0.75, maxAllowCovered 0.08).
  - Hold-out on both models: no allow run falsely blocked; not_needed 3 of 3 and already_covered
    2 of 2 caught. With 30 cases, these numbers are indicative only.
    - Two of the 7 hold-out cases are weak. `nn-translate-cocoa-spanish-unasked` differs from the
      tuning case `nn-translate-cocoa-german-unasked` only in the target language.
      `cov-resummarize-sugar-other-host` uses a `127.0.0.1` URL that the real seller would refuse
      with `unsupported_url`; Jev still judges whether the information is already in hand, so
      the label stands.
  - **Block-side margin.** The highest tuning `not_needed` score on `jev-1.14.0` in the recorded
    run was 0.41, against the 0.50 threshold. The procedure puts a margin on the allow side only,
    by design (§7.3 step 2).
  - The full output is in the build spec's Findings.
- **Decision.** `applySpendPolicy(result)` decides:
  1. The first **enforced** rule that matches blocks, checking `not_needed` first.
  2. Otherwise, the first **observed** rule that matches flags, with that rule as `wouldRefuse`.
  3. Otherwise, the check passes.
- **The exact-duplicate and repeat rules** (§3.2 step 2) are code, not Jev. They apply in both
  modes.
- **Spike observations, with draft 2 wording** (not tuning). On `jev-1.14.0`:
  - clear allows scored `servesTask` 0.62 to 0.84 and `alreadyCovered` 0.05 or less
  - a not-needed cocoa quote scored `servesTask` 0.32 to 0.45
  - a repeated translation scored `alreadyCovered` 0.68 to 0.81

### 5.2 Fail-open

Any failure makes the check **unavailable**, and the call proceeds. The budget and caps still
bound it, and an unavailable layer must never take the demo down.

- The `decided` event carries `check: { status: "unavailable", note, latencyMs }`.
- `note` is derived in this order. `APITimeoutError` is a subclass of `APIConnectionError`, so the
  order matters (spike D):

  | Failure | `note` |
  |---|---|
  | the payer's deadline fired (§4.2) | "timed out" |
  | `APITimeoutError` | "timed out" |
  | `APIUserAbortError` (the only abort source is the deadline signal) | "timed out" |
  | `APIError` (any status) | "service error (HTTP <status>)" |
  | `APIConnectionError` | "connection failed" |
  | anything else, including a malformed answer or a synchronous throw | "unexpected error" |

- The note never contains the key, headers or bodies.

### 5.3 If the pinned model is withdrawn

An unknown model id returns `BadRequestError` (HTTP 400), and a withdrawn id probably does too.

- Every check is then "unavailable", but the problem stays visible: each `[decide]` line says
  "Jev unavailable (service error (HTTP 400))", and the report counts it (§6).
- For the hosted demo, which runs unattended until Dec 15, the Phase 5 uptime check includes one
  Jev request.

## 6. Events, refusals and report

These are additive changes to [agent.md §4.5–§4.7](agent.md):

```ts
type SpendRule = 'not_needed' | 'already_covered';
type SpendCheckSummary =
  | { status: 'passed'; model: string; servesTask: number; alreadyCovered: number; latencyMs: number }
  | { status: 'blocked'; model: string; servesTask: number; alreadyCovered: number; latencyMs: number;
      repeatOf?: string }
  | { status: 'flagged'; model: string; servesTask: number; alreadyCovered: number; latencyMs: number;
      wouldRefuse: SpendRule }
  | { status: 'unavailable'; note: string; latencyMs: number };
```

- `decided` gains an optional `check?: SpendCheckSummary`, with status `passed`, `flagged` or
  `unavailable`. It is absent when the layer is off.
- `refused` gains an optional `check?: SpendCheckSummary`, with status `blocked`, for the two Jev
  codes and their repeats. A `duplicate_call` refusal has no `check`: Jev was not asked.
- **New refusal codes** (`by: "agent"`, not blocking):

  | `code` | Source | Note |
  |---|---|---|
  | `duplicate_call` | the registry rule (§3.2 step 2) | "This exact call was already made in this run" |
  | `not_needed` | the `not_needed` rule, enforced | "The decision layer judged this call not needed for the task" |
  | `already_covered` | the `already_covered` rule, enforced | "The decision layer judged this information already obtained" |

  A repeat of a Jev block uses the first block's code and note, with `detail` "Same as
  <callId>".
- **`SpendReport`** gains an optional `decisionLayer`:

  ```ts
  decisionLayer?: {
    model: string;
    modes: Record<SpendRule, 'enforce' | 'observe'>;
    passed: number;
    blocked: number;
    flagged: number;
    unavailable: number;
  }
  ```

  - It is present only when the layer was enabled.
  - `model` is the configured model. The counts come from the events; `blocked` includes repeats.
  - `duplicate_call` refusals appear in `refusals` as usual. They are not counted here.
- **CLI rendering.** Lines stay ASCII. Probabilities are printed with two decimals. The existing
  line comes first, then ` | ` and the check:
  - passed: `[decide] call_2 pay $0.05 for Page Summary API: <reason> (left after this: $0.93) | Jev: serves task 0.78, covered 0.03`
  - flagged: `[decide] … | Jev would refuse (not_needed, serves task 0.12), observe-only`. For
    `already_covered`, the number is `covered`.
  - unavailable: `[decide] … | Jev unavailable (timed out)`
  - blocked: `[refused] call_3 Market Quote API: The decision layer judged this call not needed for the task (not_needed, by agent) | Jev: serves task 0.12`
    - For `already_covered`, the number shown is `covered`.
    - A repeat ends with `, repeat of call_3`.
  - after the spend report table: `Decision layer: Jev (jev-1.14.0): N passed, N blocked, N flagged, N unavailable`
- **Tool result for a Jev refusal.** It carries `code` and `message`, as any refusal does, plus
  `check` with the two probabilities, so the model can adapt. An exact retry gets the same
  refusal (§3.2); a changed param is judged anew.
- **What the demo shows.** Each paid call gets a visible second opinion. A refusal appears only
  when the model proposes an unneeded or repeated call. The spec does not stage one.

## 7. Evaluation

`npm run eval:spend-check -w apps/agent` runs a labelled case set against the real Jev, with the
key from `.env`. It is a script, not a test, and it never runs in `npm test`.

### 7.1 Setup

- **Models.** The script scores both `jev-1.14.0` and `jev-1.13.0`. It uses
  `createJevSpendCheck({ apiKey, model })`, the exported state builder, the questions and
  `applySpendPolicy`, so it runs the shipped code.
- **Repeats.** Each case runs 3 times per model, because answers vary between runs (spike E: up
  to 0.16 on one input).
- **Size and cost.** A full run is about 180 calls, roughly $0.01.
- **Tokens.** The token and cost line handles a `null` `usage.input_tokens`, which the SDK
  allows. Such runs are counted and left out of the sum.
- **Two script modes**, to keep the hold-out unseen:
  - By default the script loads and runs the **tuning cases only**. Every wording revision
    (§7.3 step 1) is checked this way.
  - `--holdout` also loads and scores the hold-out cases, once, with the frozen configuration
    (§7.3 step 4). That run is the one recorded.
- **Unavailable runs.** A check that comes back unavailable (§5.2) is retried, up to 3 extra
  attempts per case and model.
  - If a case still lacks 3 answered runs, the eval run is **incomplete**. It is reported,
    nothing is recorded from it, and it is repeated later.
  - An unavailable attempt is never counted as a match or as a pass.

### 7.2 Cases

The cases live in `apps/agent/scripts/spend-check-cases.ts`. Labels are written **before** any
tuning, and each case states why it has its label.

- **Frozen data.** Earlier results use the demo seller's data, frozen so the file is stable
  across days:
  - quotes from `quoteAt(symbol, FIXED_AT_MS)`, at one fixed timestamp
  - articles from the fixtures, with a fixed `publishedAt`
  - summaries and translations captured once from a real demo run, then frozen in the file, so
    the eval does not call the seller's AI
- **Must-allow, the demo sequence (at least 4):** the real calls of the default demo task ("Brief
  me on today's coffee market: current price, top news, and a summary in Vietnamese."), each with
  the earlier results that precede it:
  1. quote `KC`, with no earlier results
  2. summarize the top coffee newsroom article, after the quote
  3. translate that summary into Vietnamese, after the quote and the summary. This is the most
     likely false block, because the meaning is already present in English.
  4. summarize a second coffee article
- **Other allow cases (at least 6):** other tasks over the same catalog. Examples: "What is cocoa
  trading at?" → quote `CC`; "Translate this paragraph into French" → translate.
- **`not_needed` (at least 8):** calls the task does not need. Examples: a cocoa quote for a
  coffee task, a translation when no other language is asked, premium coverage for a price-only
  question.
- **`already_covered` (at least 6):** semantic repeats the exact-duplicate rule cannot see.
  Examples: a translation into "vi" after one into "Vietnamese"; a summary of an article whose
  summary is already in the results; a quote of `KC` with different-looking but equivalent
  params, if any exist.
- **Hold-out:** at least 6 cases, marked `holdout: true`, with at least one allow case and one
  case of each block label.
  - All six spike cases (the four demo-sequence calls and the two probes) were seen before
    labelling. Those cases, and any case equal or close to them, are tuning cases.
  - Hold-out allow cases therefore come from the "other allow cases".

### 7.3 Procedure

The procedure is mechanical, so the result does not depend on hand-picked numbers. It runs on the
pinned model first.

**Terms.**

- A **run** is one answered check of one case on one model.
- A rule **matches** a run when its condition (§5.1) holds at the threshold being considered,
  whatever the rule's mode.
- An allow case is **falsely blocked** in a run when a rule in `"enforce"` mode matches it.
- A block case is **caught** in a run when the rule of its own label matches it.
  - A match of the other rule alone, for example an `already_covered` case matched by
    `not_needed`, is not a catch.
  - The confusion matrix still shows it (§7.4).

**Steps.**

1. **Tune the wording (optional).** The builder MAY revise the question wording and criteria,
   only on tuning cases, to improve separation. Each revision re-runs the tuning cases, in the
   default script mode.
2. **Compute the thresholds** from the tuning runs on allow cases, with a margin of 0.05 (spike
   E's run-to-run spread). Values are rounded to two decimals, in the safe direction:
   - `NOT_NEEDED_BELOW = min(0.50, floor2(minAllowServes − 0.05))`
   - `COVERED_ABOVE = max(0.50, ceil2(maxAllowCovered + 0.05))`
3. **Set each mode.** A rule is `"enforce"` when both of these hold; otherwise it is
   `"observe"`:
   - its computed threshold is inside the allowed range (§5.1, inclusive)
   - at least 2 of its own tuning block cases are caught in all 3 runs

   The stored threshold is the computed value clamped into the allowed range. An observed rule
   flags at that stored value.
4. **Freeze, then score the hold-out once** (`--holdout`). Nothing is tuned after this step,
   with one exception: if a hold-out allow case is falsely blocked in any run, the rule that
   blocked it is **loosened only**.
   - Its threshold moves just past that run's value, with the same margin and rounding. For
     example, `NOT_NEEDED_BELOW` becomes `floor2(value − 0.05)`.
   - Step 3 is then re-applied at the new threshold, using the recorded tuning runs; nothing is
     re-run. A rule that no longer meets it becomes `"observe"`, with its threshold clamped.
   - The loosening is reported.
   - The hold-out catch rate is reported after any loosening.
5. **Pin rule.**
   - The pin stays `jev-1.14.0` unless 1.14 ends with both rules in `"observe"` and `jev-1.13.0`,
     run through steps 2 to 4 with the same wording, enforces at least one rule.
   - Then the pin switches to `jev-1.13.0`, with 1.13's thresholds and modes, and the build
     reports why.
   - Both models' results are reported either way.

The result is always shippable. In the worst case both rules are `"observe"`: every check is
shown and flags what it would refuse, and nothing is blocked.

### 7.4 Output

- per model, one line per case:
  - id and label
  - the `servesTask` and `alreadyCovered` ranges over the runs
  - the outcomes at the computed thresholds and modes
  - ✓ or ✗. An allow case gets ✓ when no run is falsely blocked; a block case gets ✓ when it is
    caught in all 3 runs.
- per model, `minAllowServes` and `maxAllowCovered`, the computed and stored thresholds, the
  modes, and the catch count per rule
- per model, a confusion matrix counted per run, for tuning and hold-out cases separately
  - rows are the labels (allow, `not_needed`, `already_covered`)
  - columns are the policy outcomes: pass, block as `not_needed`, block as `already_covered`,
    flag as `not_needed`, flag as `already_covered`
- incomplete cases and retried attempts, per model
- latency median and p95, per model
- input tokens and the approximate cost

### 7.5 Recording and honesty

- The final wording, thresholds, modes, the pin and the full eval output (both models, tuning and
  hold-out) are recorded in this spec's §4.5 and §5.1, and in the build spec's Findings.
- The catch rate is reported honestly. With about 30 cases, numbers are indicative only, and the
  report says so.
- **Labels are never changed to fit results.** A label the builder believes is wrong is reported,
  not edited.
- **H2, a first tuning candidate** from the spike (a hypothesis, not a decision). The
  `already_covered` `false` criterion says "a translation into a language not yet present". A
  literal reading can treat `vi` and "Vietnamese" as different languages. The criterion may need
  to say that a name and a code for the same language are the same language.
- H1, the `serves_task` wording, is already applied in §4.5.

## 8. Configuration

| Variable or flag | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Enables the layer (§2). Trimmed and passed to the client explicitly; never logged. |
| `--no-spend-check` | off | CLI and demo flag that disables the layer |

- There is no runtime or configuration override of the model. The model is the pinned constant.
  Changing it is a code change that needs a new evaluation run. The factory's `model` option is
  for the evaluation and tests only (§4.3).
- The SDK's other environment variables (`TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`,
  `TYPESAFE_LOG_LEVEL`) have no effect (§4.3).
- The build adds a commented `# TYPESAFE_API_KEY` line, with a short note, to the root
  `.env.example`.
- The hosted demo uses a TypeSafe key of its own (Phase 5).

## 9. Amendments to agent.md (applied at build time)

The build applies these to [agent.md](agent.md), with a change note. Phase 3 text is extended,
never contradicted:

- **§4:**
  - `openSession` gains `spendCheck?: { checker: SpendCheck; task: string }`.
  - With the layer enabled, the session keeps the call registry (§3.1 of this spec).
- **§4.3 step 4:** a pointer to this spec's §3.2 order, which covers:
  - the registry checks
  - the payer-owned deadline
  - where `decided` is emitted
- **§4.5:** the three new refusal codes (non-blocking), and the repeat behaviour.
- **§4.6:** the optional `check` field on `decided` and `refused`.
- **§4.7:** the optional `decisionLayer` report field.
- **§7:**
  - the `--no-spend-check` flag
  - the start-up line
  - the rendering of checks
  - the decision-layer summary line
- **§8 (MCP):** a sentence that the decision layer does not run there.
- **§9 (demo):** the flag, the start-up line, and that the demo output shows the checks.

## 10. Security and privacy

- **What Jev receives:** the task, the service's catalog description and params, and bounded
  excerpts of earlier seller responses (§4.4).
  - It never receives keys, payment headers, commitment ids, operator data or the agent's private
    key.
  - Task text is sent to TypeSafe; the README says so.
- **Seller data in the state is untrusted.**
  - TypeSafe documents that Jev 1.13 does not treat state as hostile. Nothing is published for
    1.14, so this spec assumes the same.
  - A manipulated excerpt or param could at worst cause a wrong pass or a wrong block.
  - A wrong pass is still bounded by the budget and the caps.
  - A wrong block costs no money, but it can cost the task: the agent cannot get data it needs.
    That is why §7 targets zero false blocks.
  - This is why the layer is not an injection defence.
- **Key handling.**
  - The TypeSafe key is server-side only: the CLI, the demo and later the Phase 4 server. It never
    reaches a browser.
  - `baseURL` is set explicitly, so an environment variable cannot send the key to another host.
  - `logLevel` is `off`, because the SDK's `debug` level logs request bodies: the task and the
    seller excerpts.

## Change notes

- **Build notes (2026-10-16), Phase 3.5 build:**
  - §4.1: `SpendCheck` has `readonly model: string`, the configured model, because the report
    (§6) needs it and the session has no other way to know it.
  - §9 seams: `openSession`'s `spendCheck` also takes `policy?` and `deadlineMs?`, and the CLI's
    dependencies take `spendCheckFactory?`. They are test seams; the CLI and the demo never set
    them, so production uses `DEFAULT_SPEND_POLICY` and `CHECK_DEADLINE_MS`.
  - §4.2: the payer starts the latency timer before creating the deadline signal, and registers
    its deadline listener before calling `check`. So `latencyMs` is never below the deadline on a
    time-out, and the deadline wins the race even when an implementation rejects on abort with
    its own error.
  - §3.1: `earlier` lists paid records in the order they were paid. That equals the call order for
    sequential calls and is well defined for parallel ones.
  - §4.5 and §5.1: the final wording (one sentence added to the `serves_task` `true` criterion),
    the thresholds, the modes and the pin, from the evaluation (§7). H2 (§7.5) was not
    applied: the repeat into `vi` was already caught, at 0.76 to 0.79 on `jev-1.14.0`.
  - After audit round 1: §4.5 states the re-evaluation rule (any change to the questions, the
    state builder or the policy constants needs a new recorded `--holdout` run, checked by the
    SHA-256); §5.1 notes the two weak hold-out cases and the observed block-side margin.

- **Draft 4 (2026-10-16), after the second review:**
  - §5.1 and §7.3 step 3: ranges are inclusive. A stored threshold is clamped into its range, and
    a rule whose computed value fell outside the range observes at the clamped value.
  - §7.3:
    - terms are defined: run, match, falsely blocked, caught
    - after a hold-out loosening, step 3 is re-applied from the recorded tuning runs
  - §7.1:
    - the script runs tuning cases only by default, and `--holdout` scores the hold-out once
    - unavailable attempts are retried, up to 3, and an incomplete eval run records nothing
  - §7.4: ✓/✗ and the confusion matrix columns are defined.
  - §4.1 and §4.2: `latencyMs` leaves `SpendCheckResult`. The payer measures it for every outcome,
    including the deadline.
  - §4.3: the 4.75 s call is described as an inference, as in the spike README.
  - §4.4: a cut value is its first 599 characters followed by "…".
- **Draft 3 (2026-10-16), after the first review:**
  - §7.3: a mechanical procedure replaces the unfalsifiable target.
    - Thresholds are computed from allow runs with a 0.05 margin, inside allowed ranges.
    - Each rule has its own mode, and enforcement needs a minimum catch.
    - The hold-out is scored once and may only loosen a rule.
    - The pin rule is defined over the procedure.
  - §5.1: per-rule modes (`NOT_NEEDED_MODE`, `COVERED_MODE`) replace `SPEND_CHECK_MODE`. Both
    start in `"observe"`, with 0.50 thresholds, until the eval sets them.
  - §3.1: a call registry with explicit states and transitions.
  - §3.2:
    - an exact retry of a Jev-blocked call is refused with the same code, without asking Jev
    - `decided` moves after the Jev await only when the layer is on
    - why the registry rules depend on the layer
  - §4.2: the payer owns the 4 s deadline. It passes the signal and races the await; a
    synchronous throw counts as a rejection; late results are ignored.
  - §4.3: a single 4 s attempt (`maxRetries: 0`) replaces 2.5 s plus one retry. The factory gains
    a `model` option for the eval.
  - §4.4: string params are cut at 600 characters, the task at 2,000, and the state is capped at
    16,000 characters.
  - §4.5: the `serves_task` wording now targets the call with its params (former H1). Criteria may
    be revised or dropped in tuning.
  - §6:
    - exact ASCII CLI formats
    - a neutral `duplicate_call` note, with the case in `detail`
    - `repeatOf` on repeated blocks
    - `modes` in the report
  - §7: all six spike cases are tuning-only; the data is frozen at a fixed timestamp; `null`
    token counts are handled.
  - §2: the key is passed trimmed; the task string is shared. §8: `.env.example`. §10: "costs no
    money".
- **Draft 2 (2026-10-16), after the Jev spike:**
  - Model pin `jev-1.14.0` and SDK `0.7.0`.
  - Explicit client options and a total deadline.
  - Duplicate rule for uncertain and in-flight calls.
  - Fail-open mapping, observe-only mode, and both models in the eval.
- **Draft 1 (2026-10-16):** first version.
