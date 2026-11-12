# SentinelReview

SentinelReview is an early-stage security-review foundation for NEAR Rust smart contracts. It loads Rust source, applies a narrow deterministic check, validates source evidence, and provides a separate adapter for optional NEAR AI inference. It is intended to support investigation and human review, not to certify contracts or replace a complete security audit.

## How it works

The trust boundary is explicit:

1. **AI proposes hypotheses.** The optional NEAR AI adapter can return candidate findings for human review.
2. **Deterministic verification decides what is reproducible.** Local rules generate deterministic candidates, and evidence validation checks their references against the loaded source snapshot. AI output is schema-checked and its source locations are checked before it can be accepted, but these checks do not prove an AI hypothesis is correct.
3. **People interpret the result.** Neither a deterministic result nor an AI response determines exploitability, completeness, or safety.

The current deterministic rule is deliberately narrow: it looks for NEAR Rust callback-result handlers without a recognized `#[private]` attribute or its narrowly supported direct predecessor/current-account guard. It may miss indirect or alternative authorization logic; a recognized manual guard is reported as inconclusive rather than proof that the guard is effective.

## Installation

Prerequisites: Node.js `>=24.22.1` (npm is included with Node.js) and Git.

From the repository root, install the locked dependencies:

```bash
npm ci
```

## Local checks and demos

```bash
npm run typecheck
npm test
npm run demo:deterministic
npm run demo:deterministic -- safe
```

The source loader applies bounded traversal defaults: at most 200 Rust files, 1 MiB per file, 5 MiB total source, 2,000 directory entries examined across the tree (including directories and non-Rust files), and directory depth 32 (source root = depth 0). These limits can be overridden through the loader options when used as a library. Exceeding an entry or depth limit fails the load; no partial snapshot is returned.

When loading a contract for review, point the loader at the contract's Rust source directory (the directory containing the relevant `.rs` files), not the repository or workspace root. This avoids spending the bounded entry budget on unrelated files, build output, or dependencies.

The deterministic demo is local and does not call an AI service:

- With no argument, it loads `demo-fixtures/callback-unguarded/lib.rs`, which contains a callback-result method with no recognized access guard. The narrow rule emits an informational candidate.
- The `safe` argument loads `demo-fixtures/callback-safe/lib.rs`, which uses `#[private]`; this rule emits no finding for that fixture.

The JSON report includes the source hash, file-manifest hash, file count, rule status and limitations, findings, and evidence-integration status. The manifest hashes are SHA-256 fingerprints of the loaded `.rs` files and their canonical manifest; they help identify the analyzed snapshot but do not establish its origin or provenance. For emitted findings, evidence integration checks the evidence schema, source and manifest hashes, file identity, line range, and excerpt hash, and reports unresolved or invalid evidence instead of presenting it as validated.

This demo exercises only the selected rule against two small fixtures. A `passed` status or zero findings means only that this rule emitted no finding for the selected fixture. It does **not** prove the source is safe, vulnerability-free, or fully audited.

## Optional live NEAR AI inference

Live inference is separate from the local deterministic demo; the demo commands above require no credentials and make no provider request. The adapter in `src/ai/near-ai-adapter.ts` is an implementation interface, not a package-level live-review command.

When inference is actually enabled, the adapter sends the complete loaded Rust-source snapshot (each file's path and contents) together with deterministic-finding metadata to the configured NEAR AI model. The adapter sends neither source nor findings if the complete source exceeds 256 KiB or the serialized prompt exceeds 320 KiB; it does not truncate either to fit. Inference also requires a configured `NEARAI_API_KEY` and explicit operator-approved model deployment measurements; with no approved measurements, inference is not run. The API key should be supplied through the runtime environment or application configuration, never committed to the repository.

The client configures the NEAR AI SDK with `e2ee: true` and Ed25519 signing, and validates attestation and response-verification results before accepting AI findings. These implementation details do not establish provider retention practices, absolute confidentiality, or guarantees about data handling; consult current provider documentation and your organization's policies before sending source to a service. No live inference result is asserted here.

## Attestation and deployment measurements

The inference adapter checks the SDK-verified gateway/model attestation against its configured policy, requires an `UpToDate` TCB status, required GPU evidence, verified model deployment provenance, and runtime Compose/OS-image measurements matching the operator-supplied approved measurements. It also requires a usable model Ed25519 key before inference. After inference, it requires a verified response ID matching the completion ID and a `provider_tee` response signature associated with approved model-attestation evidence before accepting candidates.

These are checks and measurements observed or enforced by the implementation; they are not an independent security review or independent NEAR approval. The separate `scripts/near-ai-attestation-discovery.ts` utility reports the gateway/model TCB and GPU verification results, runtime Compose and OS-image hashes, and a bounded Compose image inventory. Discovery explicitly reports `deploymentProvenance: "not_checked"` and `measurementApproval: "not_approved"`. A parsed Compose file is configuration data, not proof that those images were deployed or approved.

## Controlled canary

The controlled canary in `scripts/near-ai-controlled-canary.ts` is conditional and is not part of the local demo or CI. It requires `NEARAI_API_KEY` plus operator-supplied values for `NEARAI_OPERATOR_APPROVED_MODEL_ID`, `NEARAI_OPERATOR_APPROVED_COMPOSE_HASH`, and `NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH`. The model value must match the canary's fixed model, and the supplied hashes must match the runtime measurements returned by attestation. The canary then checks the configured TCB/GPU and gateway TLS-attestation policies, sends only its fixed synthetic prompt, and verifies the response ID and provider TEE signature. The values are an operator-controlled allowlist, not independent NEAR approval; its report preserves `independentNearApproval: "not_established"`. These prerequisites describe how it can be run; they do not mean a live canary has been performed successfully.

## Continuous integration

`.github/workflows/ci.yml` runs for pull requests targeting `main` and pushes to `main`. On Ubuntu with Node.js 24.22.2, it runs `npm ci`, `npm run typecheck`, `npm test`, the default deterministic demo, and the `safe` deterministic demo. CI does not perform live NEAR AI inference or a live canary.

## Security limitations and interpretation

- The deterministic rule set is limited and is not a complete audit.
- A finding, whether deterministic or AI-generated, does not by itself establish exploitability.
- Absence of findings does not establish safety or absence of vulnerabilities.
- Evidence validation checks correspondence to the supplied snapshot; a matching hash is not independent provenance.
- Attestation, signature, TCB, GPU, and measurement checks establish only the properties they check. They do not prove analysis correctness, completeness, provider retention behavior, or independent approval.
- Treat incomplete, failed, unavailable, inconclusive, and not-run states as limitations, not as passing results.

SentinelReview is an evolving foundation. Its reports and measurements should be interpreted alongside source review, tests, and an appropriately scoped independent security assessment.
