# Post-Mortems — mcp-second-opinion

Short, honest record of what actually broke (or nearly did) while building this server, and the rule each failure left behind. Small project, so this file is small — every entry below is a real thing that happened, not ceremony. Newest on top; numbering is stable.

**Conventions**
- **Status:** `RESOLVED` (fix landed + guarded) · `MITIGATED` · `OPEN`.
- **Severity (impact on the user of the tool, not on me):** `P1` broken out of the box / wrong results · `P2` robustness or quality gap · `P3` papercut.

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
