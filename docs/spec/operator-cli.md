# PayPer402 operator CLI: design spec

> Status: draft 2 (2026-10-27), for roadmap Phase 4.5. It passed review in round 2 on
> 2026-10-27. Normative keywords follow RFC 2119.

The `payper402` command lets an operator connect an agent from a terminal in one step, and lets
any MCP client (Claude Code, Claude Desktop) pay per call through PayPer402.

1. In the web app, the operator asks for a **claim code**. It is short, single-use and expires in
   15 minutes. The page shows the full command.
2. On the agent's machine, `payper402 onboard --claim <code>` **generates the agent's Ed25519 key
   locally** and redeems the code with the public key only. The facilitator creates the agent.
   The private key never leaves that machine.
3. `payper402 status` shows what the agent may spend right now, and why it is blocked if it is.
4. `payper402 mcp` runs the existing MCP server (agent.md §8) with that identity, so Claude Code
   can call paid APIs. `payper402 run "<task>"` runs the existing Claude agent (agent.md §7).

This document amends [facilitator.md](facilitator.md) (new endpoints and migration 3),
[web-app.md](web-app.md) (one new entry point) and [agent.md](agent.md) (the new command). Each of
those files gets a change note that points here. Implementation details (files, tests,
milestones) are in [docs/phase-4.5/BUILD_SPEC.md](../phase-4.5/BUILD_SPEC.md).

## 1. Scope

**In scope:**

- Claim codes: issued by an operator, redeemed with a public key (§3).
- An agent-signed, read-only status endpoint (§4).
- Migration 3: the `agent_claims` table (§5).
- The `payper402` command: `onboard`, `status`, `mcp`, `run`, `help` and `version` (§6), and its
  config file (§7).
- The web app's "Connect from a terminal" option (§8).
- README instructions: install the command and add it to Claude Code (§6.8).

**Out of scope** (stated so that nobody adds them):

- **Operator powers in the CLI.** Linking PayPal, setting caps, unlinking, pausing agents and
  manual charges stay in the web app. Linking needs a person in a browser anyway. The CLI never
  holds an operator API key.
- Publishing the package to npm. The command is installed from the repository (§6.8).
- Several identities on one machine (profiles). One config file holds one agent; `PAYPER402_HOME`
  selects another directory (§7).
- Key rotation, and deleting agents. An unwanted agent is paused in the web app.
- A new MCP tool. The MCP server keeps exactly the three tools of agent.md §5.
- Telling the web page live that a claim was redeemed. The new agent appears in the Agents list.

## 2. Flow

```
Web app (operator session)         Facilitator                       Agent machine (payper402)
--------------------------         -----------                       -------------------------
"Connect from a terminal", name
POST /api/operator/agents/claims
  -> POST /v1/agents/claims  ----> stores HMAC(code), 15 min TTL
  <- { code, expiresAt }     <---- (code shown once)
shows: payper402 onboard --claim ABCD-EFGH-JKMN --api https://...
                                                                     generates Ed25519 key
                                   POST /v1/claims/redeem  <-------- { code, publicKeyX }
                                   creates the agent (public key)
                                   ------------------------------->  { agent, operator, sellerUrl }
                                                                     writes ~/.payper402/config.json
                                   GET /v1/agent/status    <-------- signed with the agent key
                                   (read-only view)        -------->  payper402 status
Seller (x402) <-------------------------------------------------- payper402 mcp / run: paid calls,
                                                                     unchanged (agent.md §4)
```

## 3. Claim codes

### 3.1 Format

- **Alphabet:** Crockford base32, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
- **Length:** 12 characters drawn uniformly at random with `crypto.randomInt` (60 bits).
- **Display form:** three groups of four joined by `-`, for example `K7QM-2XRD-9VHT`.
- **Normalised form**, used for hashing: remove `-` and whitespace, uppercase, then map `O` to
  `0` and `I` and `L` to `1` (Crockford decoding). The normalised form MUST be exactly 12
  characters of the alphabet; anything else is rejected before any lookup (400
  `validation_failed`).
- **Stored form:** only `code_hash = HMAC-SHA256(API_KEY_PEPPER, "claim:" + normalised)` in hex,
  unique. The `claim:` prefix keeps claim hashes apart from API key hashes. The plaintext code
  appears only in the issuing response.

### 3.2 Lifetime

- **TTL:** 900 seconds from issue. A claim is **open** while `redeemed_at IS NULL` and
  `now < expires_at`.
- **Single use:** a redeemed claim can never be redeemed again.
- **At most 5 open claims per operator.** A sixth gets 409 `too_many_claims`. Expired claims stop
  counting the moment they expire.
- Expired and redeemed rows are kept as a record. Nothing deletes them in this phase.

### 3.3 `POST /v1/agents/claims` (operator key)

Mounted inside the existing `/v1/agents` router, so the operator-key middleware already applies
(facilitator.md §4).

- **Body:** strict `{ name, sellerUrl? }`.
  - `name`: the same schema as `POST /v1/agents` (trimmed, 1 to 100 characters).
  - `sellerUrl`: optional, an absolute `http:` or `https:` URL of at most 300 characters, stored
    with trailing slashes removed. It is passed back to the CLI on redemption (§3.4), so the
    command needs no `--seller` flag. The facilitator never fetches it.
- **Effect:** one IMMEDIATE transaction that:
  1. loads the operator (404 if missing, as the other routes do)
  2. counts the operator's open claims, and answers 409 `too_many_claims` at 5
  3. inserts the `agent_claims` row (§5)
  4. writes the audit record `agent.claim_issued` (actor `operator`, resource `agent_claim`,
     details `{ name }`; never the code)
- **Response:** 201 `{ claim: { id, code, name, expiresAt } }`, where `code` is the display form.
  The code appears only in this response.
- No event is emitted.

### 3.4 `POST /v1/claims/redeem` (unauthenticated)

Mounted at its own prefix `/v1/claims`, **outside** `/v1/agents`: `app.use('/v1/agents',
operator, …)` puts operator authentication on every path below `/v1/agents`.

- **Body:** strict `{ code, publicKeyX }`, with `code` a string of at most 40 characters and
  `publicKeyX` of at most 100.
- **Rate limit** (§9.3) before anything else; over the limit gets 429 `too_many_requests`.
- **Validation:** the code normalises as in §3.1, and `kidFromPublicKeyX(publicKeyX)` succeeds.
  Otherwise 400 `validation_failed`, with the same `publicKeyX` issue text as `POST /v1/agents`.
- **Effect:** one IMMEDIATE transaction, with no `await` inside:
  1. Find the claim by `code_hash`. None: 404 `claim_not_found`.
  2. `redeemed_at` is set: 409 `claim_used`.
  3. `now >= expires_at`: 410 `claim_expired`.
  4. An agent with this `kid` exists: 409 `agent_key_exists` (the claim stays open).
  5. Insert the agent exactly as `POST /v1/agents` with `publicKeyX` does: id `agt_…`, the claim's
     `agent_name`, status `active`, the audit record `agent.created` (actor `operator`, the
     claim's operator) with details `{ generatedKey: false, via: 'claim', claimId }`.
  6. `UPDATE agent_claims SET redeemed_at = ?, agent_id = ? WHERE id = ? AND redeemed_at IS NULL`.
     Zero rows would mean a concurrent redemption, which the synchronous transaction already
     rules out; it is still checked, and answers 409 `claim_used` with the transaction rolled
     back.
  7. Audit `agent.claim_redeemed` (actor `system` / `claim`, resource `agent_claim`, details
     `{ agentId }`).
- **After the commit:** emit `agent.updated` `{ id, status: 'active' }` to the operator, as
  `POST /v1/agents` does. The web app's live updates (web-app.md §13) then show the agent.
- **Response:** 201

  ```json
  {
    "agent": { "id", "name", "kid", "keyFingerprint", "status", "createdAt" },
    "operator": { "name" },
    "sellerUrl": "https://… or null"
  }
  ```

  `agent` is the existing `agentView`. No operator id, caps or wallet data is returned here.
- **Errors** use the standard error body (facilitator.md §7). The 404, 409 and 410 codes are
  distinct so the CLI can say what to do (§6.3). They reveal nothing to a caller who does not
  already hold the code.

## 4. Agent-signed requests and `GET /v1/agent/status`

### 4.1 Why a signature, not a token

The CLI already holds the agent's private key. Signing each status request with it adds no new
secret, no new table and no change to `api_keys` (whose `owner_type CHECK` would need a table
rebuild). The only new endpoint behind it is read-only, so a replay inside the time window
returns the same kind of data to whoever already captured one response, and changes nothing.

### 4.2 Header

```
Authorization: PayPer402-Agent <kid>.<iat>.<sig>
```

- `kid`: the agent's key id (43 characters of base64url).
- `iat`: unix seconds, decimal, no sign, no leading zeros.
- `sig`: base64url Ed25519 signature (86 characters) over the message below.
- The header MUST match `^PayPer402-Agent ([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,11})\.([A-Za-z0-9_-]{86})$`.

**Signed message:** the domain prefix `payper402-agent-request:v1\n` followed by
`canonical({ kid, iat, method, path })`, where:

- `canonical` is the binding's RFC 8785 helper (`@payper402/scheme-paypal`), and `iat` is the same
  integer as in the header
- `method` is the uppercase HTTP method, `GET`
- `path` is the request path without the query, exactly `/v1/agent/status`

The prefix differs from the commitment signature domain and neither is a prefix of the other, so
a request signature can never verify as a commitment signature, or the reverse.

### 4.3 Verification

In this order, each failure answering 401 `unauthorized` with the message "Missing or invalid
agent signature":

1. The header matches §4.2.
2. `|now − iat| ≤ 120`.
3. An agent with this `kid` exists. Its `public_key_x` is used.
4. The signature verifies over the message rebuilt from the header's `kid` and `iat` and the
   request's own method and path.

A paused agent passes: it can still read its status. The rate limit (§9.3) runs before step 1.
Logs carry the request id and the outcome, never the header.

### 4.4 Response

`GET /v1/agent/status` answers 200 with a least-privilege view, computed with the existing helpers
(`agentWithUsage`, `operatorBlockReason`, `capsView`, `walletView`, the `GET /v1/operator`
usage query):

```json
{
  "agent": { "id", "name", "keyFingerprint", "status", "createdAt",
             "spentToday", "spentTotal", "callsToday", "lastCallAt" },
  "operator": { "name" },
  "wallet": { "status", "stoppedAt", "lastChargeAt", "lastChargeAmount", "lastChargeStatus" },
  "caps": { "perCall", "daily", "unsettled", "total" },
  "usage": { "spentToday", "notYetCharged", "notYetChargedCalls", "spentTotal" },
  "remainingToday": 77,
  "blocked": false,
  "blockReason": null
}
```

- `agent.*` are this agent's own figures. `usage.*` are the operator's, because the caps are
  per operator: they are the same values as `GET /v1/operator` `usage`.
- `caps` is exactly `capsView` (as in `GET /v1/operator`): `total` is **absent** when the operator
  has no total limit. Clients treat it as optional.
- `remainingToday` is `max(0, caps.daily − usage.spentToday)`.
- `blocked` and `blockReason` are exactly the operator's (facilitator.md §7.2); they do not look
  at the agent's own `status`. The CLI shows a paused agent separately (§6.4).
- **Never included:** the operator id, the payer's masked email, other agents, settlement ids,
  commitments, API keys.

## 5. Data model: migration 3

Additive; no table is rebuilt.

```sql
CREATE TABLE agent_claims (
  id          TEXT PRIMARY KEY,                       -- clm_…
  operator_id TEXT NOT NULL REFERENCES operators(id),
  code_hash   TEXT NOT NULL UNIQUE,
  agent_name  TEXT NOT NULL,
  seller_url  TEXT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  redeemed_at INTEGER NULL,
  agent_id    TEXT NULL REFERENCES agents(id)
);
CREATE INDEX agent_claims_operator ON agent_claims(operator_id, expires_at);
```

- Numbered 3 and recorded like the others (facilitator.md §5). A database at version 2 is upgraded
  on start-up.
- **Seed reset:** `seed --reset` deletes an operator's `agent_claims` rows before its agents and
  the operator (the foreign keys require it).

## 6. The `payper402` command

### 6.1 Entry and conventions

- **Lives in `apps/agent`**, beside the agent CLI and the MCP server it reuses.
- `payper402 <command> [flags]`, parsed with `node:util` `parseArgs`, strict.
- **Output:** human text on stdout; errors on stderr as one line starting `Error: `. ASCII only in
  tags, as agent.md §7 requires for Windows consoles. Money uses the agent package's own
  `formatUsd` (`src/tools.ts`, for example `$0.08`).
- **Unknown command or flag:** the `Error: …` line, then the usage text (§6.2), both on stderr,
  and exit 1.
- **Exit codes:** 0 on success; 1 on any error, including an unknown command or flag.
- **Secrets:** no output, error, or log line contains the private key, the claim code (after
  redemption) or a signature.
- `--api <url>` and `--seller <url>` accept absolute `http:` or `https:` URLs only, trailing slashes
  removed.

### 6.2 `payper402 help` (also `--help`, `-h`, and no command)

Prints the usage text:

```
payper402 - pay-per-call for AI agents, settled with PayPal

Usage:
  payper402 onboard --claim <code> [--api <url>] [--seller <url>] [--force]
                              Connect this machine as an agent, with a claim code from the web app
  payper402 status [--json]   Show what this agent may spend now, and why it is blocked if it is
  payper402 mcp [--budget <usd>] [--max-per-call <usd>]
                              Start the MCP server over stdio
  payper402 run [--budget <usd>] [--max-per-call <usd>] [--no-spend-check] "<task>"
                              Run the Claude agent on a task
  payper402 version           Print the version
  payper402 help              Show this message

Config: <resolved config path>
```

`version` (also `--version`, `-v`) prints the `apps/agent` package version.

### 6.3 `payper402 onboard`

Flags: `--claim <code>` (required), `--api <url>` (default `http://localhost:4020`), `--seller
<url>`, `--force`.

1. **Existing config.** If the config file exists and `--force` is not given: error "This machine
   is already connected as <name>. Use --force to replace it; the old key is deleted." No request
   is made.
2. **Key.** Generate a key with `generateAgentKey`. It stays in memory until step 4.
3. **Redeem.** `POST <api>/v1/claims/redeem { code, publicKeyX }` with a 15-second timeout.
   Errors map to messages:

   | Answer | Message |
   |---|---|
   | 404 `claim_not_found`, 400 `validation_failed` on `code` | That claim code is not valid. Check it, or create a new one in the web app. |
   | 409 `claim_used` | That claim code was already used. Create a new one in the web app. |
   | 410 `claim_expired` | That claim code has expired. Create a new one in the web app. |
   | 429 | Too many attempts. Wait a minute and try again. |
   | network error or timeout | Could not reach PayPer402 at <api>. |
   | anything else | PayPer402 answered <status>. Try again. |

   On any error the generated key is discarded and no file is written.
4. **Write the config** (§7) with the agent from the response, the `--api` URL, and the seller
   URL: `--seller` if given, otherwise the response's `sellerUrl`, otherwise
   `http://localhost:4021`.
   - If writing fails after a successful redemption, print "The agent <name> was created, but
     the config could not be saved: <reason>. Pause it in the web app and create a new claim
     code." and exit 1. The key is not printed. The agent exists without a usable key, which is
     harmless.
5. **Print:**

   ```
   Connected as <name> (<keyFingerprint>) for <operator name>.
   Your private key stays on this machine: <config path>

   Next:
     payper402 status
     claude mcp add payper402 -- payper402 mcp
   ```

   On Windows the last line is `claude mcp add payper402 -- cmd /c payper402 mcp`. Both lines
   assume the global command of §6.8.

### 6.4 `payper402 status`

Flags: `--json`.

- Reads the config (§7). No config: error "This machine is not connected. Run payper402 onboard
  --claim <code> first."
- `GET <facilitatorUrl>/v1/agent/status`, signed (§4), with a 15-second timeout.
  - 401: error "PayPer402 does not recognise this agent's key. Create a new claim code and run
    payper402 onboard --force."
  - Network errors and other answers: as in §6.3.
- `--json` prints the response body as it is, pretty-printed, and exits 0.
- Otherwise prints:

  ```
  Agent        research-bot  ed25519:Ab3dE9wXyz  for Northwind Research
  State        Ready to pay
  Limits       $0.10 per call, $1.00 per day, $5.00 not yet charged, no total limit
  Today        $0.23 spent, $0.77 left (this agent: $0.15 in 3 calls)
  Not charged  $0.20 in 4 calls
  PayPal       Linked. Last charge $0.08, completed, 2026-10-27 14:05 UTC
  Seller       http://localhost:4021
  ```

  - **Agent:** the name, `agent.keyFingerprint` printed unchanged, and the operator name.
  - **Today:** `usage.spentToday` and `remainingToday` (the operator's), then the agent's own
    `agent.spentToday` and `agent.callsToday`.
  - **Not charged:** the operator's `usage.notYetCharged` and `usage.notYetChargedCalls`.

  - **State**, the first that applies:
    1. agent `paused`: "Paused by the operator"
    2. `blockReason = 'wallet_not_active'`: from the wallet status, "PayPal stopped by the payer"
       (`stopped_by_payer`), "PayPal not linked" (`not_linked`, `link_failed`), "Waiting for
       PayPal approval" (`waiting_for_approval`) or "PayPal is being unlinked" (`unlinking`)
    3. `daily`: "Daily limit reached"; `unsettled`: "Waiting for a PayPal charge (not-yet-charged
       limit reached)"; `total`: "Total limit reached"
    4. otherwise "Ready to pay"
  - **PayPal**: "Linked" or the State wording for the wallet status. "Last charge …" only when
    `lastChargeAt` is set; times are UTC, `YYYY-MM-DD HH:MM UTC`.
  - **Limits**: "no total limit" when `caps.total` is absent.
- Exit 0 whenever a status was printed, blocked or not.

### 6.5 `payper402 mcp`

Flags: `--budget <usd>`, `--max-per-call <usd>`.

- Reads the config. Builds the agent configuration through the existing `loadAgentConfig` from
  `{ ...process.env, AGENT_PRIVATE_KEY: <config key>, SELLER_URL: <config seller URL> }` and the
  flags, so `AGENT_BUDGET` and `AGENT_MAX_PER_CALL` still apply and the flags override them.
- Then does exactly what `src/mcp.ts` `main` does (agent.md §8): opens the session, connects
  `createMcpServer` to a stdio transport, and logs the ready line to stderr. The shared steps are
  one function used by both entries.
- **Nothing is written to stdout** before or besides the MCP protocol: not the help text, not
  warnings. Every error goes to stderr and exits 1.
- No decision layer, as agent.md §8 says.

### 6.6 `payper402 run`

Flags: `--budget`, `--max-per-call`, `--no-spend-check`, and the task as positional words.

- Reads the config, then calls the existing `runCli(argv, env, io)` (agent.md §7) with
  `env = { ...process.env, AGENT_PRIVATE_KEY: <config key>, SELLER_URL: <config seller URL> }` and
  the remaining arguments. Output, decision layer and exit codes are those of agent.md §7.
- Anthropic credentials and `TYPESAFE_API_KEY` come from the environment, as for the agent CLI.

### 6.7 Key and seller precedence

- `payper402` takes the agent key **only from its config file**. An `AGENT_PRIVATE_KEY` in the
  environment is ignored by `payper402` (it would not match the agent that `status` reports).
- The seller URL comes from the config file. To change it, run `onboard` again.
- The facilitator URL comes from the config file.
- The existing `npm run agent` and `npm run mcp` entries are **unchanged**: they read only the
  environment, as before, and never the config file.

### 6.8 Installing it

The command runs from a clone of the repository. It is never installed from the npm registry:
`apps/agent` depends on the workspace packages `@payper402/*`, which exist only as workspace links,
so `npm install --global ./apps/agent` would look them up in the registry. That route is **not**
used.

- **The shim:** `apps/agent/bin/payper402.mjs` registers tsx's ESM loader (`tsx/esm/api`
  `register()`) and imports `src/payper402.ts`, because the workspace sources use extensionless
  imports that plain Node cannot resolve. `tsx` resolves from the repository's `node_modules`
  (the root's existing dev dependency); no dependency is added.
- **The global command:** the **root** `package.json` gets `"bin": { "payper402":
  "apps/agent/bin/payper402.mjs" }`. After `npm install`, running `npm link` at the repository
  root links `payper402` onto the PATH. The link points at the clone, so every module resolves
  from the clone's own `node_modules`.
- **Without a global command:** `npm run --silent payper402 -- <command>` from the repository root
  (a root script, §6.1 output unchanged; `--silent` keeps npm's banner off stdout), and
  `node <repo>/apps/agent/bin/payper402.mjs <command>` from anywhere.
- **Claude Code:** with the global command, `claude mcp add payper402 -- payper402 mcp` (on
  Windows, `-- cmd /c payper402 mcp`). Without it, `claude mcp add payper402 -- node
  <repo>/apps/agent/bin/payper402.mjs mcp`, which needs no PATH entry and works on every system.
  The README gives both.
- The shim MUST print nothing itself, so `payper402 mcp` keeps stdout clean.
- **Verification:** the builder runs `npm link` at the root on Windows, then `payper402 --help`,
  `payper402 version` and `payper402 mcp` with no config (nothing on stdout), and records the
  result. **If `npm link` does not give a working command, the builder stops and reports it**
  rather than inventing another install route; the `node …/payper402.mjs` form then becomes the
  only documented one, and the `claude mcp add` lines in §6.3 and §8.3 change to it, through a
  spec change.

## 7. Config file

- **Directory:** `PAYPER402_HOME` if set, otherwise `~/.payper402` (`os.homedir()`).
- **File:** `config.json`:

  ```json
  {
    "version": 1,
    "facilitatorUrl": "http://localhost:4020",
    "sellerUrl": "http://localhost:4021",
    "operatorName": "Northwind Research (demo)",
    "agent": { "id": "agt_…", "name": "research-bot", "kid": "…", "keyFingerprint": "ed25519:…" },
    "privateKey": "<43-character base64url seed>",
    "createdAt": 1793000000
  }
  ```

- **Reading:** validated with a strict zod schema. A missing file is "not connected" (§6.4). An
  invalid file is the error "The config at <path> is invalid. Run payper402 onboard --force." The
  error never echoes the file's content.
- **Consistency:** on read, the key's derived `kid` MUST equal `agent.kid`; otherwise the same
  "invalid" error.
- **Writing:** create the directory with mode `0o700`, write `config.json.tmp` with mode `0o600`,
  then rename it over `config.json`. On Windows the modes are not enforced; the README says the file
  holds the agent's private key, like a `.env`.
- `onboard --force` replaces the file; the old key is gone.

## 8. Web app: "Connect from a terminal"

A minimal addition to the frozen design: no new board. It reuses the existing buttons, code
blocks, toasts and panel styles.

### 8.1 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FACILITATOR_PUBLIC_URL` | `FACILITATOR_URL` | The facilitator URL the CLI uses, shown in the command |
| `SELLER_PUBLIC_URL` | `SELLER_URL` | The seller URL stored with each claim |
| `WEB_LIMIT_CLAIMS_PER_HOUR` | `10` | Claim codes per operator per hour |

### 8.2 Server route

`POST /api/operator/agents/claims`, operator session, same-origin check (web-app.md §15.2), body
strict `{ name }` with the web app's agent-name rule (web-app.md §10.5).

- Calls `POST /v1/agents/claims { name, sellerUrl: SELLER_PUBLIC_URL }`.
- Answers 201 `{ claim: { code, name, expiresAt }, command }`, where `command` is
  `payper402 onboard --claim <code> --api <FACILITATOR_PUBLIC_URL>`.
- 409 `too_many_claims` passes through; its copy is "You have 5 unused codes. Use one or wait
  for them to expire." Other errors follow web-app.md §7.
- The per-operator limit (§8.1) answers 429 `claim_limit` with the message "Too many claim codes
  right now. Try again later." (a constant beside `RUN_LIMIT_MESSAGE`).
- Nothing is stored in the session cookie: the web app never holds a key for these agents, so
  "Run this agent" stays disabled for them (web-app.md §4.4).

### 8.3 UI

In the name step of the Agents drawer and of onboarding step 3 (web-app.md §10.5, §10.8):

- Below "Create agent", a secondary button **"Connect from a terminal"**. It validates the same
  name field and calls the route above.
- On success the step is replaced by the **claim panel**:
  - heading "Run this on the agent's machine"
  - the command in a code block, with "Copy" (toast "Command copied")
  - "Code <display code> · expires at <HH:MM> (15 minutes)", local time
  - the line "The agent creates its own key. PayPer402 only receives the public key."
  - a smaller code block with `claude mcp add payper402 -- payper402 mcp` and the line "Then
    Claude Code can pay for APIs within your limits."
  - a link "Install the payper402 command", to the README section when `NEXT_PUBLIC_REPO_URL` is
    set, hidden otherwise
- **Onboarding:** while the panel is shown, the step's footer controls ("Skip for now" and "I
  saved the key") are replaced by one primary button, "I ran the command", which goes to the Done
  screen.
- **Drawer:** while the panel is shown, the drawer's footer controls are replaced by one primary
  button, "Done", which closes the drawer. The new agent appears in the list when it connects
  (live updates, web-app.md §13).
- No countdown, no polling.

## 9. Security

### 9.1 Keys

- The agent key is generated on the agent's machine and stored only in its config file. The
  facilitator and the web app see only the public key.
- The CLI never holds an operator API key. The worst a stolen config file allows is spending
  within the operator's caps until the operator pauses the agent, the same as a leaked
  `AGENT_PRIVATE_KEY` today.

### 9.2 Claim codes

- A claim code is a bearer secret for 15 minutes. Whoever redeems it first registers *their* key
  as an agent of that operator. The limits: 60 bits of entropy, a 15-minute life, single use, at
  most 5 open per operator, rate-limited redemption, and the operator sees every new agent in the
  list and can pause it.
- The facilitator stores only the code's HMAC. Logs and audit records never contain the code.

### 9.3 Rate limits (facilitator, in process)

- **Client key:** the first `X-Forwarded-For` address when `FACILITATOR_TRUST_PROXY=1`, otherwise
  one shared bucket. Sliding windows in memory, reset by a restart (like web-app.md §15.3).

| Limit | Default |
|---|---|
| `POST /v1/claims/redeem` per client | 10 per minute |
| `POST /v1/claims/redeem`, all clients | 300 per hour |
| `GET /v1/agent/status` per client | 60 per minute |

- Over a limit: 429 `too_many_requests` with `Retry-After` in seconds.
- `FACILITATOR_TRUST_PROXY` is a new optional facilitator variable, default `0`. With `0`, every
  caller shares one bucket per limit. **Phase 5 hosting MUST set it to `1`** behind its proxy, or
  all CLI users share 10 redemptions and 60 status reads per minute. The roadmap's Phase 5
  security task carries this.

### 9.4 Other

- The new facilitator endpoints send no CORS headers, like every other route.
- Request signatures are domain-separated from commitment signatures (§4.2).
- The redeem and status bodies and headers are never logged.
- Sandbox only, unchanged.

## 10. Amendments to the other specs

- **facilitator.md:** §1 and §13 note that the two new endpoints are rate-limited in process; §3
  gains `FACILITATOR_TRUST_PROXY`; §4 gains the agent signature scheme (pointing to §4 here); §5
  gains migration 3; §7's general rules gain 410 and 429; §7.8 "Agent claims and agent status"
  points to §3 and §4 here; §14 notes the seed reset order; a change note.
- **web-app.md:** §3.1 gains the three variables of §8.1; §7 gains the route of §8.2; §10.5 and
  §10.8 gain the "Connect from a terminal" button and the claim panel; §15.3 gains the claim
  limit; a change note.
- **agent.md:** §7 and §8 gain a note that the `payper402` command (operator-cli.md §6) wraps
  them with the config file, and that `npm run agent` and `npm run mcp` are unchanged; a change
  note.

## 11. Build notes

Choices the build made where this spec was silent. None changes a rule above; the details and the
tests are in [docs/phase-4.5/BUILD_SPEC.md](../phase-4.5/BUILD_SPEC.md), Findings.

- **Shared agent insertion (§3.4 step 5).** `insertAgent` writes the row and the `agent.created`
  audit record for both `POST /v1/agents` and claim redemption. It does not emit `agent.updated`:
  each caller emits after its own commit, which for redemption is after the transaction.
- **Rate limit keys (§9.3).** With `FACILITATOR_TRUST_PROXY=1` and no `X-Forwarded-For` header the
  request falls into the shared bucket. Expired keys are swept once a window holds more than 10,000.
  `express.json` runs before the limiter, so a request with malformed JSON is answered 400 without
  counting against it.
- **Redeem errors (§3.4).** A bad `code` and a bad `publicKeyX` are reported together in one 400
  `issues` list.
- **Agent auth logging (§4.3).** One debug line per request with the request id and a reason
  (`bad_header`, `stale`, `unknown_agent`, `bad_signature`); the client always gets the same 401.
  The signed path is the mount plus the rest of the path (`/v1/agent/status`), without the query.
- **Client calls (§6.3, §6.4).** Both calls refuse redirects, so a signed request is never forwarded.
  A 400 `validation_failed` on `code` maps to "not valid"; any other 400 is "answered 400".
  `status --json` prints every field the facilitator sent. `onboard` writes nothing if the returned
  agent's `kid` is not the generated key's.
- **Existing config (§6.3 step 1).** An existing but invalid config file also needs `--force`; its
  message omits the agent name: "This machine already has a config at <path>. Use --force to
  replace it; the old key is deleted."
- **Usage errors (§6.1).** A missing `--claim`, an unknown flag and an unexpected positional
  argument print the `Error:` line and the usage. An invalid `--api` or `--seller` URL prints the
  `Error:` line only.
- **Status text (§6.4).** With a total limit the Limits line ends "<amount> total"; a charge
  status such as `needs_review` is printed "needs review"; an unknown wallet status reads "PayPal is
  not active"; counts use the singular ("1 call"). The PayPal line repeats the State wording when the
  wallet is not linked.
- **`mcp` and `run` (§6.5, §6.6).** Both validate their flags strictly before reading the config, so
  an unknown flag gets the usage. A configuration error from `run` is printed by `runCli` as the
  agent CLI always prints it (no `Error:` prefix); from `mcp` it is printed with the prefix. `SIGINT`
  is hooked only for `run`.
- **Shared MCP start-up (§6.5).** `startMcpStdio(config, log?, transport?)` returns the server, or
  the reason it could not start, instead of throwing.
- **Web claim route (§8.2).** The facilitator's 409 `too_many_claims` is passed through and its copy
  is in `lib/copy.ts`. The per-operator limit takes its hit before the facilitator call, so an upstream
  409 still counts. `FACILITATOR_PUBLIC_URL` and `SELLER_PUBLIC_URL` fall back to the internal URLs
  when unset or blank.
- **Web UI (§8.3).** The onboarding "I ran the command" link goes to the Done screen with the claim's
  agent name; if that agent has not connected yet, the screen names the account's newest agent, as
  it does for any unknown name.
