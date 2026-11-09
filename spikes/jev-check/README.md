# Jev spike: check the SDK and the model before Phase 3.5

This spike answers one question before the decision-layer spec goes to review: **does
`@typesafe-ai/sdk` 0.7.0 with Jev 1.14 behave the way the spec assumes?**

- If yes, draft 2 of the spec pins `jev-1.14.0` and SDK `0.7.0`.
- If not, draft 2 records what changes, or stays on `jev-1.13.0`.

`jev-1.14.0` (released 2026-10-14) is what the `jev-preview` alias points to. The stable alias
`jev-latest` still points to `jev-1.13.0`. TypeSafe publishes caveats for 1.13 only.

## Run

```bash
npm run spike -w spikes/jev-check -- --offline
npm run spike -w spikes/jev-check
npm run spike -w spikes/jev-check -- --repeats 5
```

The online checks need `TYPESAFE_API_KEY` in the root `.env`. The script never prints the key.
The cost is a fraction of a cent: input tokens cost $0.042 per million, and output is free.

## What it checks

| # | Check | Why it matters for the spec |
|---|---|---|
| O1 | SDK version | Pin `0.7.0` |
| O2 | The client constructor with no key | §2 enables the layer only when a key exists |
| O3 | An invalid request | 0.7.0 says it rejects the promise and no longer throws |
| O4 | Worst-case duration with a hanging server | §4 sets `timeout: 4000` and `maxRetries: 1` |
| O5 | A response body that stalls mid-way, and a caller abort | 0.7.0 fixed unhandled rejections there |
| A | `GET /v1/models` | Does it list versioned ids? |
| B | One call per model name | Check `response.model` for `jev-1.14.0`, `jev-1.13.0` and the two aliases |
| C | The request on the wire, with default compression and with `compression: false` | Unit tests that read the state field names from a mocked `fetch` |
| D | Error classes from the real API: bad key, unknown model, 1 ms timeout, connection refused | The §5 fail-open notes |
| E | The four demo-sequence calls and two sanity probes, on both models | Early sign of false blocks. This is **not** the §7 eval |
| F | Latency median and p95, and cost per call | Each check adds latency to a paid call in the live demo |

The demo cases use the seller's real quote and article fixtures. The summaries and the
Vietnamese translation are fixed stand-ins for the seller's Claude output, which varies between
runs.

The two sanity probes are drawn from the §7 examples: a cocoa quote, and a repeat translation
into `vi`. They only show that the probabilities move. They must not be used as hold-out
cases in the §7 eval.

## Results

### Offline (2026-10-16, SDK 0.7.0, Node 24.18.0)

| # | Result |
|---|---|
| O1 | `VERSION = 0.7.0` |
| O2 | The constructor **throws** `TypeSafeError` ("No API key was provided") synchronously |
| O3 | An empty `questions` map rejects the promise with `TypeSafeError`; `systemOne` does not throw |
| O4 | `timeout` applies **per attempt**, with no total budget: 300 ms with 0 retries took 319 ms; with 1 retry, 1038 ms; with the default 2 retries, 2290 ms |
| O4 | A caller `AbortSignal.timeout(500)` stops the call at 511 ms, but the error is `APIUserAbortError`, not `APITimeoutError` |
| O5 | A stalled body ends as `APITimeoutError` at the timeout; a caller abort mid-body ends as `APIUserAbortError` |
| O5 | No unhandled rejections in any case |

### Online (2026-10-16, from Vietnam, two runs: 3 and 6 repeats)

**Access and wire format.**

| # | Result |
|---|---|
| A | `GET /v1/models` lists only the aliases `jev-latest` and `jev-preview`, no versioned ids |
| B | `jev-1.14.0` is answered by `jev-1.14.0`, and `jev-1.13.0` by `jev-1.13.0`. `jev-latest` is answered by `jev-1.13.0`, `jev-preview` by `jev-1.14.0`. The key can use both versions |
| C | The demo case 3 request is 2955 bytes of JSON. By default it is sent as a 1187-byte `Uint8Array` with `Content-Encoding: zstd`, which `zlib.zstdDecompressSync` decodes. With `compression: false` it is a plain JSON string |
| C | The wire shape is `{ state: { task, proposed_call: { service, description, params }, earlier_results: [...] }, questions: { <id>: { type, instructions, criteria } }, model }` |
| D | A bad key gives `AuthenticationError` (401). An unknown model gives `BadRequestError` (**400, not 404**). A 1 ms timeout gives `APITimeoutError`. A refused connection gives `APIConnectionError` |

**Demo cases (E).** The table gives ranges over both runs, which is 9 calls per case per model.
Thresholds are draft 1's 0.20 and 0.85.

| Case | Want | 1.14 `servesTask` | 1.14 `alreadyCovered` | 1.13 `servesTask` | 1.13 `alreadyCovered` |
|---|---|---|---|---|---|
| demo-1 quote `KC` | pass | 0.63–0.74 | 0.01 | 0.67–0.72 | 0.02 |
| demo-2 summarize top article | pass | 0.76–0.80 | 0.03–0.04 | 0.66–0.70 | 0.06–0.07 |
| demo-3 translate summary to Vietnamese | pass | 0.62–0.72 | 0.03–0.04 | 0.58–0.64 | 0.05–0.06 |
| demo-4 summarize second article | pass | 0.83–0.84 | 0.04–0.05 | 0.74–0.80 | 0.07 |
| sanity: cocoa quote for the coffee task | not_needed | 0.32–0.45 | 0.02 | 0.42–0.58 | 0.05–0.06 |
| sanity: translate again, into `vi` | already_covered | 0.68–0.73 | 0.68–0.81 | 0.50–0.58 | 0.86–0.90 |

- **No false blocks** on any must-allow case, on either model, in any run.
- **The draft 1 thresholds miss the cocoa probe on both models.** They also miss the repeat
  translation on 1.14; only 1.13 crosses 0.85 there.
- **Separation, indicative only (one probe per block type):**
  - `servesTask`: on 1.14 the lowest allow is 0.62 and the highest cocoa value is 0.45, a gap.
    On 1.13 the two overlap at 0.58.
  - `alreadyCovered`: both models leave a wide gap: allows stay at 0.07 or below and the repeat
    at 0.68 or above.
- **No clear allow scores near 1.** All `servesTask` values are between 0.58 and 0.84.

**Latency and cost (F).** Each row covers that run's section E calls. Timeout 4000 ms,
`maxRetries: 1`.

| Run | Model | n | Median | p95 | Max | Retried attempts |
|---|---|---|---|---|---|---|
| 1 | 1.14 | 18 | 287 ms | 4750 ms | 4750 ms | not counted yet |
| 1 | 1.13 | 18 | 257 ms | 1583 ms | 1583 ms | not counted yet |
| 2 | 1.14 | 36 | 341 ms | 1121 ms | 2720 ms | 0 |
| 2 | 1.13 | 36 | 306 ms | 1234 ms | 1539 ms | 0 |

- The 4750 ms call is most likely a first attempt that hit the 4000 ms timeout, then a backoff,
  then a fast retry. One attempt cannot outlast the per-attempt timeout, but run 1 did not
  count retries.
- Mean input is 952 tokens per call (545 with no earlier results), about **$0.00004 per call**.
- No unhandled rejections in either run.

## Findings for draft 2 of the spec

1. **The spec's worst case is about 8.5 s, not 4 s.** `timeout: 4000` with `maxRetries: 1` means
   two attempts plus a backoff of about 500 ms. Options:
   - `maxRetries: 0` with a single shorter timeout
   - keep the retry, and bound the total with an `AbortSignal.timeout(total)` passed per call
2. **A deadline set through `AbortSignal` surfaces as `APIUserAbortError`.** The §5 note mapping
   has no case for it. If the spec uses a total deadline, map that abort to "timed out". Keep a
   real caller cancellation distinct from it.
3. **Check `APITimeoutError` before `APIConnectionError`.** The first is a subclass of the
   second.
4. **Build the client only after the key check.** The constructor throws without a key, so
   `createJevSpendCheck` must not be reached when §2 says the layer is off.
5. Invalid requests reject, and nothing leaks as an unhandled rejection, so a single
   `try`/`await`/`catch` around `systemOne` is enough for fail-open.
6. **Pin `jev-1.14.0`, as the newest model.** The spike found no regression on the must-allow
   cases, with the same latency and cost as 1.13. Two probes cannot say which version judges
   better: 1.14 scored the cocoa probe lower, but only 1.13 caught the repeat into `vi`. Each
   probe is a single input repeated, so the repeats measure noise, not separation.
   - **The §7 eval should score both `jev-1.14.0` and `jev-1.13.0`.** At about $0.00004 per call
     this costs nothing, and the pin then rests on evidence. If the preview id ever has to be
     dropped, the 1.13 results are already there.
   - The risk is that 1.14 is a preview build. An unknown id returns `BadRequestError` (400), and
     a withdrawn one probably does too. Any `APIError` makes the check "unavailable", so the
     layer would go quiet with no other signal. The spec should say how that is surfaced.
7. **The thresholds must come from the §7 eval.** Draft 1's 0.20 and 0.85 catch neither probe on
   1.14, and clear allows score only 0.6 to 0.84. These are observations, not tuning: the probe
   set is far too small to set numbers.
8. **Wording hypotheses for §7 to test, not changes made here:**
   - The cocoa probe may score high because the question asks about "the service", and the
     service's description names coffee. Asking about `proposed_call` *with its `params`* may
     read better.
   - On 1.14, the repeat into `vi` may score below the threshold because the `false` criterion
     says "a translation into a language not yet present". A literal reading can treat `vi`
     and "Vietnamese" as different languages.
9. **Timeout budget.** In 108 calls, most likely one attempt went past 4 s (run 1 did not count
   retries); otherwise the slowest call took 2.7 s. The spec should choose a total budget from these numbers, together with
   findings 1 and 2.
10. **Compression.** Either keep zstd and decode bodies in tests with `zstdDecompressSync`, or
    set `compression: false`. The body is about 3 KB, so the saving is small, and
    `compression: false` keeps the tests simple.
