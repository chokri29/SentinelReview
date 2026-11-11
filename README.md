# SentinelReview

SentinelReview is a privacy-focused security review foundation for NEAR Rust smart contracts. It combines bounded source ingestion, deterministic checks, validated source evidence, and a NEAR AI inference adapter designed to keep AI-generated hypotheses separate from reproducible findings.

> **Project status (11 November 2026):** The repository has a working security-analysis foundation and an implemented NEAR AI adapter. The project is still under active development; it is not yet a complete end-to-end auditing product, and no claim of independent NEAR approval or comprehensive contract safety is made.

## Progress snapshot

### Implemented foundations

- [x] TypeScript project structure, versioned Zod contracts, and Vitest test suite.
- [x] Bounded Rust source loader with path restrictions, file/byte limits, strict UTF-8 handling, and deterministic line accounting.
- [x] Immutable source snapshots and canonical manifest/source hashing.
- [x] Deterministic evidence validation for source identity, file paths, hashes, line ranges, and excerpts.
- [x] Evidence integration with findings, including explicit unresolved/incomplete states.
- [x] Initial deterministic NEAR Rust callback-result access-control rule. The rule is intentionally conservative: uncertain syntax or possible manual guards produce limitations/inconclusive results rather than a clean bill of health.
- [x] NEAR AI adapter with strict candidate-response validation, source-grounded evidence handling, and separation of AI hypotheses from deterministic findings.
- [x] SDK-backed attestation/response-verification handling and a controlled synthetic canary implementation with focused tests.
- [x] Discovery diagnostics for inspecting NEAR AI gateway/model attestation and deployment measurements.

The repository includes focused tests for the implemented modules. Historical test runs were performed during earlier milestones; rerun the full suite and typecheck against the current checkout before treating the latest combined state as verified.

### Current work in progress

- [ ] Compose deployment-image inventory parsing in the NEAR AI discovery report. Local work has started, including bounded input/service/image limits, YAML parsing, sanitized image-reference output, and malformed/unsupported input tests. This work is **not yet present in the current `main` branch** and must not be treated as completed or verified.
- [ ] Review the complete image-reference parser and its edge cases before merging that work.
- [ ] Re-run `npm run typecheck` and `npm test` after the current changes are finished.

### Remaining roadmap

#### 1. Deterministic security analysis
- [ ] Expand the NEAR Rust rule set beyond the initial callback-result rule.
- [ ] Record rule/tool versions and reproducible analysis metadata.
- [ ] Add broader safe-control and seeded-vulnerability fixtures.

#### 2. Private AI analysis and provenance
- [ ] Complete a controlled provider canary using real, operator-supplied deployment measurements.
- [ ] Document exactly what provider attestation and response-signature checks establish—and what they do not.
- [ ] Keep independent NEAR approval distinct from operator-supplied measurement matching.

#### 3. Reports and end-to-end workflow
- [ ] Define report generation, coverage accounting, and explicit limitations.
- [ ] Separate response verification, evidence validation, and report-integrity verification.
- [ ] Add end-to-end tests covering source intake through final report.

#### 4. Security, reliability, and demo
- [ ] Expand tests for malformed input, prompt injection, timeouts, and provider failures.
- [ ] Enforce and test privacy-safe logging, access controls, and retention boundaries.
- [ ] Verify unavailable, failed, inconclusive, and not-run states can never appear as successful checks.
- [ ] Build a reproducible demo and document setup and operational requirements.

## Current technical outline

- **Contracts:** `src/contracts/v1.ts`
- **Source ingestion and hashing:** `src/source/load-source.ts`, `src/source/manifest-hash.ts`
- **Evidence validation and integration:** `src/source/validate-evidence.ts`, `src/source/integrate-evidence.ts`
- **Deterministic NEAR Rust rule:** `src/rules/near-rust-callback-private.ts`
- **NEAR AI adapter:** `src/ai/near-ai-adapter.ts`
- **Controlled canary:** `src/ai/near-ai-controlled-canary.ts`
- **Attestation discovery:** `scripts/near-ai-attestation-discovery.ts`

## Development commands

Use Node.js `>=24.22.1` as declared in `package.json`.

```bash
npm install
npm run typecheck
npm test
```

Provider credentials belong only in a local/server environment. Never commit real API keys or sensitive deployment measurements.

## Verification principles

- **AI proposes; deterministic checks and validation decide what is presented as reproducible evidence.**
- AI findings are hypotheses for human review; they do not establish exploitability.
- A missing finding does not mean a contract is safe or fully audited.
- A verified provider response signature does not prove analysis correctness or completeness.
- Operator-supplied deployment measurements are not independent NEAR approval.
- Evidence validation, provider attestation, response verification, and report integrity are separate properties.
- Failed, unavailable, inconclusive, and not-run checks must never be represented as passed.

## Scope and limitations

SentinelReview is an evolving foundation, not a production-ready audit certification service. The current deterministic rule set is narrow, the full report/workflow layer remains incomplete, and the project does not claim exhaustive vulnerability detection, independent deployment approval, or a guarantee that reviewed contracts are safe.
