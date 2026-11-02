# SentinelReview

SentinelReview is a privacy-focused AI security review platform for NEAR smart contracts. It combines NEAR AI private inference with deterministic security checks to identify potential vulnerabilities, validate evidence, and generate verifiable audit reports while protecting sensitive source code.

> **Status:** Early-stage project. The roadmap below tracks planned work; a checked item means the feature has been implemented and verified, not merely planned.

## Roadmap

### 1. Foundations
- [ ] Establish application structure and module boundaries
- [ ] Define versioned request, finding, evidence, and report schemas
- [ ] Add input validation, source snapshotting, and resource limits

### 2. Deterministic security analysis
- [ ] Integrate the initial NEAR Rust contract checks
- [ ] Record tool versions, rule identifiers, and reproducible results
- [ ] Add safe-control and seeded-vulnerability fixtures

### 3. Private AI analysis
- [ ] Integrate NEAR AI private inference behind a server-side adapter
- [ ] Validate AI responses against a strict schema
- [ ] Keep AI hypotheses distinct from deterministic findings
- [ ] Verify provider response metadata using documented SDK behavior

### 4. Evidence and reports
- [ ] Fingerprint the frozen source and file manifest
- [ ] Validate evidence paths, source hashes, and line ranges
- [ ] Generate reports with explicit coverage and limitations
- [ ] Separate response verification from report-integrity verification

### 5. Security, reliability, and demo
- [ ] Test malformed input, prompt injection, timeouts, and provider failures
- [ ] Enforce privacy-safe logging, access controls, and retention boundaries
- [ ] Verify failure states never appear as successful checks
- [ ] Complete end-to-end tests and a reproducible demo

## Verification principles

- **AI proposes; deterministic checks and validation decide what is presented as reproducible evidence.**
- A missing finding does not mean a contract is safe or fully audited.
- A signature or attestation does not prove analysis correctness or completeness.
- Evidence validation, response verification, and report integrity are separate properties.
- Failed, unavailable, inconclusive, and not-run checks must never be represented as passed.

## Development acceptance checklist

The detailed build and test checklists are maintained as development criteria. A milestone is complete only after its corresponding tests pass and its limitations are documented. The public roadmap is intentionally concise; it does not replace detailed test cases and threat-model notes.
