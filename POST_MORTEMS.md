# Post-Mortems — mcp-second-opinion

Short, honest record of what actually broke (or nearly did) while building this server, and the rule each failure left behind. Small project, so this file is small — every entry below is a real thing that happened, not ceremony. Newest on top; numbering is stable.

**Conventions**
- **Status:** `RESOLVED` (fix landed + guarded) · `MITIGATED` · `OPEN`.
- **Severity (impact on the user of the tool, not on me):** `P1` broken out of the box / wrong results · `P2` robustness or quality gap · `P3` papercut.

---

## 6. A QA-engineer pass: an untrimmed key 401'd silently, and the tool's own glue had no test

**Date:** 2026-06 · **Status:** RESOLVED (v0.3.2–0.3.3) · **Severity:** P1 (the key) + P2 (the gap)

**Symptoms:** Two things a QA-lens pass surfaced that **all 91 green tests — and even live happy-path checks — had missed**:
1. `OPENROUTER_API_KEY` was read as `process.env… ?? ""` with no trim. A key sourced from a file or pasted with a trailing newline became `Authorization: Bearer sk-…\n` — a malformed header that **401'd every single call**, with no hint why. The most common first-run setup (key in a config, copy-paste, `$(cat key)`) *was* the failure case.
2. `index.ts`'s tool handler — the load-bearing glue (key check → resolve → fan-out → score → synthesize → compose) — was only ever verified by hand with a live key. Every *piece* had a unit test; the *wiring* had none, so a refactor could silently break the `isError` logic, the disagreement→synthesizer hand-off, or the dropped-models note and CI would stay green.

**Detection:** A deliberate QA pass that (a) diffed the *mocked* response shapes against the **live** OpenRouter API — confirming chat `usage` and embeddings `index`/dim actually matched — and (b) exercised real failure modes end-to-end (wrong key, dead embed model, client disconnect → process exit) instead of trusting the mocks. The untrimmed key was caught by reasoning about how keys are actually supplied; the test gap, by asking "what here is checked *only* by hand?"

**Root Cause:**
1. Treating an environment secret as clean input. Operators don't hand-tune env files; they paste, and `$(cat key)` keeps the newline.
2. The handler had grown real branching logic while remaining un-extracted, so it sat *below* the unit-test line and *above* the live-only line — the classic untested middle.

**Fix:**
1. `(process.env.OPENROUTER_API_KEY ?? "").trim()`. A whitespace-only key now also degrades to the clean "key not set" message instead of a 401.
2. Lifted the flow into `handler.runSecondOpinion(args, config, deps)` with `fetch`/`sleep`/`embedder` injected, and added `handler.test.ts` (13 tests): key-missing short-circuit, partial-vs-total failure → `isError`, disagreement on/off + best-effort survival of an embedder failure, the flag→synthesizer hand-off, synthesis-failure degradation, and the cap/dropped note — all with no network. The refactor is behaviour-preserving (the prior 91 tests stayed green) and was re-checked live.

**Lesson / Rule:** **A green suite of mocked unit tests says nothing about whether the mocks match reality, or whether the glue between them is wired right.** Trim env secrets; and when a handler grows logic, extract it to where it's testable with injected I/O instead of leaving it in the untested middle between unit tests and manual live checks.

---

## 5. The design assumed OpenRouter had no embeddings; verifying killed a heavy dependency

**Date:** 2026-06 · **Status:** RESOLVED (v0.3.0) · **Severity:** P2

**Symptoms:** The disagreement-scoring plan committed to bundling Transformers.js — a sizeable dependency, a ~23 MB ONNX model downloaded on first use, cold-start latency, and a "CI must not download the model" caveat — all resting on the stated assumption that *"OpenRouter is chat-completions only, no embeddings."*

**Detection:** Before writing the embedder, one live probe — `POST /api/v1/embeddings` with the existing key — returned `200` with a real vector.

**Root Cause:** The assumption was inherited from OpenRouter's chat-first reputation and **never checked against the live API**. An entire heavyweight design rested on it.

**Fix:** Use OpenRouter's `/embeddings` with the *same* key — `openrouter.embed()` + a thin `makeOpenRouterEmbedder`. No new dependency, no model download, no CI caveat, lower latency. The `Embedder` interface stayed injectable, so swapping in a local/API embedder later is still a one-liner.

**Lesson / Rule:** **Verify a load-bearing assumption against the live API before designing around it** — the same lesson as PM #1, one layer up: there it was a single model id, here it was a whole capability. A five-second probe deleted a dependency, a download, and a CI workaround.

---

## 4. A second skeptical audit caught a whitespace-empty panel and a latency-multiplying retry

**Date:** 2026-06 · **Status:** RESOLVED (v0.2.1) · **Severity:** P2

**Symptoms:** Two issues a fresh Tech-Lead-lens review of v0.2.0 surfaced — **with all 40 tests green**:
1. Model ids that were only whitespace (`"  "`) slipped past the zod `min(1)` schema, were then trimmed away by dedup, and left an empty panel that returned a confusing `# Second opinion — 0 models` with `isError: false`.
2. A model that hit its per-attempt timeout was classified *transient* and retried up to N times — tripling the worst-case latency of a member that was already the slowest, while the rest of the panel had long since answered.

**Detection:** A deliberate second audit, not the unit tests (they passed). Both were blind spots the first pass shipped.

**Root Cause:**
1. `z.string().min(1)` validates string **length**, not non-blank **content** — `"  "` has length 2. Schema validation is not input normalization.
2. Lumping a read-timeout in with network errors as "transient" ignored that a timeout has already spent its full budget and usually signals an overloaded model — retrying rarely helps and always costs.

**Fix:** `resolveModels` (config.ts) falls back to the default panel when a request normalises to empty; timeouts became `PermanentError` (not retried) while genuine network failures still retry. The handler's decision logic was extracted into a pure `composeResult` so `isError` / empty / dropped are now unit-tested. Tests 40 → 49.

**Lesson / Rule:** **Schema `min(1)` is not "non-empty" — validate length *and* normalize/trim content, and always have a fallback for when normalization can empty a required input. And don't retry a timeout: its budget is spent, and retrying only multiplies the slowest member's latency.**

---

## 3. The first cut fanned out unbounded, with no retries

**Date:** 2026-06 · **Status:** RESOLVED (v0.2.0) · **Severity:** P2

**Symptoms:** v0.1 used `Promise.all` over every requested model with no concurrency cap, no dedup, and no retry. A 20-model request fired 20 simultaneous calls; a transient `429`/`503` from a provider was recorded as a permanent `FAILED`; the same id passed twice was billed twice; and an HTTP-200 response carrying an `{"error": …}` body surfaced as a vague "no message content".

**Detection:** A deliberate self-audit (architect + tech-lead review) before promoting the repo, plus a live run where a transient provider blip became a hard failure.

**Root Cause:** The first cut optimised for "does the happy path work" and skipped the failure-mode engineering that a fan-out tool lives or dies by. **Fan-out amplifies every weakness N times** — one missing retry becomes N flaky members.

**Fix (v0.2.0):** bounded concurrency (`mapWithLimit` semaphore in `panel.ts`), dedup (`config.dedupe`), bounded retry with backoff + jitter on transient statuses and fast-fail on `4xx` (`openrouter.chatCompletion`), HTTP-200-with-error detection, per-answer token accounting, and a panel-size cap. Tests went 7 → 40, including the resilience invariant.

**Lesson / Rule:** A fan-out primitive must treat **resilience as the core feature, not a follow-up**: bound the concurrency, dedup the inputs, retry the transient, fail-fast the permanent, and make any single member's failure non-fatal. "Works on the happy path" is not "works".

---

## 2. zod 4 was installed; the MCP SDK is built against zod 3

**Date:** 2026-06 · **Status:** RESOLVED · **Severity:** P2

**Symptoms:** `npm view zod version` returned `4.x`. The MCP SDK's `registerTool` takes a zod **v3** `ZodRawShape` for `inputSchema`; a separately-installed zod 4 risks type incompatibility against the SDK's bundled zod-3 types and subtle changes in parsing/validation behaviour.

**Detection:** Caught proactively at dependency-selection time — confirmed the SDK's major before writing any tool schema, rather than after a confusing type error.

**Root Cause:** `@modelcontextprotocol/sdk@^1.29` is typed against zod 3; zod 4 reworked internals and the public schema surface. A bare `npm install zod` grabs the latest major and silently mismatches the SDK.

**Fix:** Pinned `"zod": "^3.25.0"` in `package.json`.

**Lesson / Rule:** When a library hands you its own validation primitive (zod raw shapes here), **your version of that library must match theirs** — pin the shared peer to the major the SDK targets instead of letting `npm install` pull a newer major.

---

## 1. A shipped default model id 404'd on the live API

**Date:** 2026-06 · **Status:** RESOLVED · **Severity:** P1

**Symptoms:** Calling `second_opinion` with no `models` argument returned, for one of the three default panel members, `google/gemini-2.0-flash-001 — FAILED: HTTP 404 "No endpoints found for google/gemini-2.0-flash-001"`. The default panel was broken out of the box for a zero-config first run.

**Detection:** Caught **only** by live end-to-end verification (a real MCP client making a real OpenRouter call) — **never by the unit tests**, which mock `fetch` and therefore accept any well-formed-but-nonexistent model id.

**Root Cause:** `DEFAULT_MODELS` hardcoded `google/gemini-2.0-flash-001`, an id that does not exist on OpenRouter — provider model ids drift and differ from the vendor's own naming. Mock-based tests can validate logic but can never validate the **catalog**. (The resilience design from PM #3 is also why this was easy to miss: the bad default degraded gracefully instead of crashing.)

**Fix:** Queried `GET https://openrouter.ai/api/v1/models` for valid current ids and switched the default to `google/gemini-2.5-flash-lite`, confirmed live.

**Lesson / Rule:** **Any hardcoded external id (model, endpoint, region) must be verified against the live provider before shipping — typecheck and mocked tests prove the logic, never the catalog.** Defaults especially must work on a zero-config first run, so live-verify them.
