# SentinelReview (AI Studio Edition)

SentinelReview is a NEAR Rust smart-contract security review workbench combining deterministic static analysis and cryptographic evidence verification with an explicitly gated, optional NEAR AI hypothesis path.

> **Scope & Status**: SentinelReview supports investigation and human code review. It is **not** a complete security audit, an exploitability oracle, or a smart-contract safety certification.

---

## Core Trust Boundary

**AI may propose hypotheses -> deterministic checks and evidence recomputation decide what is reproducible -> human reviewers interpret the result.**

The deterministic review pipeline runs without contacting any AI provider:

1. **Contracts & Schemas** (`src/contracts/v1.ts`): Versioned Zod schemas (`1.0.0`) for source manifests, findings, evidence records, analysis results, and review reports.
2. **Bounded Source Ingestion** (`src/source/load-source.ts`, `src/source/custom-snapshot.ts`): Loads `.rs` files under strict file-count (`200`), per-file (`1 MiB`), and aggregate (`5 MiB`) limits, validates canonical POSIX relative paths and reversible UTF-8, and produces deeply frozen immutable snapshots.
3. **SHA-256 Manifest Hashing** (`src/source/manifest-hash.ts`): Computes domain-separated `fileManifestHash` and `sourceHash` values over sorted canonical entries.
4. **Deterministic AST Rule** (`src/rules/near-rust-callback-private.ts`, `src/rules/parse-rust.ts`): Parses Rust syntax with `@lezer/rust` (`NEAR-RUST-CALLBACK-PRIVATE-001`) to detect NEAR `#[callback_result]` handlers lacking `#[private]` or a narrowly recognized direct fail-closed predecessor/current-account guard.
5. **Independent Evidence Validation & Integration** (`src/source/validate-evidence.ts`, `src/source/integrate-evidence.ts`): Recomputes snapshot integrity, canonical file references, physical line bounds, and domain-separated excerpt hashes, and verifies unique finding-to-evidence reference resolution.
6. **Optional NEAR AI Adapter** (`src/ai/near-ai-adapter.ts`): Separate, explicit-consent hypothesis path using `@nearai/inference-sdk` with E2EE, TCB status (`UpToDate`), GPU evidence, operator-approved deployment measurements (`composeHash` + `osImageHash`), and `provider_tee` response signature verification.

---

## Execution Model & Privacy Boundaries

When running in Google AI Studio, the Express backend is hosted remotely on the AI Studio server runtime:

1. **Browser -> AI Studio Backend (Deterministic Processing)**:
   - Bundled demo fixtures (`demo-fixtures/callback-unguarded` and `demo-fixtures/callback-safe`) reside on the AI Studio backend.
   - Custom Rust code pasted or uploaded in the browser is transmitted over HTTP(S) to the AI Studio backend (`POST /api/review/custom`) in bounded memory for SHA-256 manifest hashing, deterministic AST analysis, and evidence verification. No external AI provider is contacted during this step.
2. **AI Studio Backend -> NEAR AI Provider (Optional, Explicit Consent Only)**:
   - Inactive by default. Source code is transmitted to the configured NEAR AI provider (`POST /api/ai-review`) **only** when the user explicitly checks the consent confirmation and submits a valid same-origin request carrying `x-sentinelreview-ai-consent: 1` and a valid 2-minute single-use consent token bound to the exact `snapshotHash` and server model configuration.
   - If `NEARAI_API_KEY` or operator-approved deployment measurements (`NEARAI_OPERATOR_APPROVED_COMPOSE_HASH`, `NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH`) are not configured, inference does not execute.
3. **Cryptographic & Attestation Verification**:
   - SHA-256 manifest/excerpt hashes verify snapshot and excerpt correspondence.
   - NEAR AI TEE attestation and response verification validate deployment measurements and response signatures; they do **not** mean the remote provider does not process transmitted source code to generate hypotheses.

---

## Running & Testing in AI Studio

### Environment Variables

Configure secrets only in the server environment (see `.env.example` — never commit real `.env` files or secrets):

- `NEARAI_API_KEY`: Optional NEAR AI API key for gated hypothesis inference.
- `NEARAI_OPERATOR_APPROVED_COMPOSE_HASH`: Required compose measurement hash to enable NEAR AI inference.
- `NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH`: Required OS image measurement hash to enable NEAR AI inference.

Note: The model ID (`z-ai/glm-5.3-flash`) is deliberately hardcoded in the adapter (`src/ai/near-ai-adapter.ts`) and is not configurable via environment variables.

### Commands

```bash
npm run dev        # Start Express + Vite workbench on 0.0.0.0:3000
npm test           # Run Vitest suite (unit, snapshot, adapter, and API tests)
npm run typecheck  # Run TypeScript compiler checks (tsc --noEmit)
npm run lint       # Run lint/typecheck verification
npm run build      # Build production frontend bundle into dist/
npm start          # Start production Express server serving dist/ on 0.0.0.0:3000
```

### Test Coverage & Reconciliation Notes

The `tests/` directory covers:

- **Deterministic core**: `tests/contracts.v1.test.ts`, `tests/source/load-source.test.ts`, `tests/source/manifest-hash.test.ts`, `tests/source/validate-evidence.test.ts`, `tests/source/integrate-evidence.test.ts`, `tests/rules/near-rust-callback-private.test.ts`, and `tests/demo/deterministic-review.test.ts`.
- **Custom Rust & UI helpers**: `tests/source/custom-snapshot.test.ts` (custom paste, multi-file `.rs` uploads, path/encoding/limit/BOM/CRLF/CR checks) and `tests/ui/source-lines.test.ts` (physical line highlighting).
- **NEAR AI adapter, canary & SDK compatibility (mocked, no network calls)**: `tests/ai/near-ai-adapter.test.ts`, `tests/ai/near-ai-controlled-canary.test.ts`, and `tests/sdk/nearai-sdk-compat.test.ts`.
- **Express API & security enforcement**: `tests/server/api.test.ts` (fixtures, custom snapshots, same-origin + userinfo origin rejection, consent header, `415` content-type, single-use & concurrent token consumption, expiry, `409` hash/config mismatch, `404` evicted custom snapshot, and security/no-store headers).

The original upstream GitHub `tests/` directory was not present in the imported AI Studio baseline; the suite above restores coverage from the imported modules rather than claiming unverified parity with unseen upstream files. Upstream `near-ai-attestation-discovery` tests are marked not applicable here because the attestation-discovery script is not part of this AI Studio workbench, and `demo-fixtures/` plus in-test fixtures cover the `safe` and `triggering` source fixture scenarios.

