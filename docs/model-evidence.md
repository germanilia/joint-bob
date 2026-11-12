# Evidence-based allocation

The initial rollout is an explicit recommendation preview under **Settings → Classifiers**. It does not change a running model, enable the quality collector, install a harness, or spend a recovery allowance.

Assess a bounded task description with the configured decision model, then provide candidate identities and cost assumptions in the advanced preview. The first candidate is the baseline. Manual selection is preserved by default. The server loads only this account's derived outcomes from accessible projects on this machine; callers cannot supply another account's history or project access list.

## Evidence and identity

`src/model-evidence.ts` validates independent domain, complexity, risk and confidence fields. Model identity includes provider, model ID, release, harness, scaffold version and reasoning configuration. Different identities are never pooled. Legacy records without this attribution or verified outcomes must not be promoted to successes.

The official [SWE-bench leaderboard](https://www.swebench.com/) was inspected through the designated browser on 2026-11-12. Its Verified view describes 500 human-filtered tasks and defaults to mini-SWE-agent, with scaffold releases and reasoning settings. Those results are not directly interchangeable with Pi, Claude or Kiro. No leaderboard scores were imported because exact portable identities and fresh results were not established. The schema currently supports only this verified benchmark/version/unit; other benchmarks require a reviewed adapter rather than silently comparable scores.

A record expires after 90 days from publication or retrieval. Refreshing an old result's retrieval date cannot make the result fresh. Evidence must retain its source URL, dates, sample size and limitations. No background scraper runs.

## Recommendation policy version 1

- At least 20 distinct known task outcomes in the same domain, complexity and risk group are required.
- Unknown, authentication and unavailable-model outcomes are not successes.
- A compatible public result contributes at most ten prior observations. It cannot raise the empirical conservative quality floor.
- Conservative quality floors are 0.60, 0.75 and 0.90 for low, medium and high risk. Assessment confidence below 0.80 retains the baseline. These are conservative preview parameters, not validated production thresholds.
- Expected cost includes supplied attempt, handoff, evaluation and likely recovery estimates. Any unknown price excludes the candidate; unknown is not zero.
- Reports are observational, not causal comparisons or per-task success guarantees. Held-out analysis excludes training task IDs and includes failed-attempt costs and latency when known.

The preview's availability/capability/cost fields are caller-provided assumptions. A preview is not proof of usable credentials. Actual dispatch must recheck the current account, provider, harness, resource grants and manual pins.

## Storage and recovery boundary

`AllocationStore` stores derived account/project-scoped outcome records only. It has no transcript, prompt, credential or command column. Collection is default-off. The current preview does not backfill legacy transcripts or infer missing attribution.

Recovery primitives require explicit opt-in, held-out validation, a finite positive allowance, a stopped writer and no uncertain external operation. They reserve cost transactionally, allow at most two stronger attempts, and return `dispatch: false` when an operation ID is repeated. An interrupted reservation remains fenced until its actual execution is reconciled. Settlement records actual spending; it cannot authorize another attempt beyond the allowance.

**Still gated:** automatic cross-provider/harness dispatch, production outcome attribution/collection integration and activation based on accepted held-out evidence. The preview and reservation primitives alone are not an autonomous router. No paid recovery or live evaluation was enabled by this change.

## API

- `GET /api/routing-configs/allocation`: account-scoped availability and rollout status.
- `POST /api/routing-configs/allocation/assess`: `{ taskId, text, capabilities }`; one batched decision-model request, no prompt persistence.
- `POST /api/routing-configs/allocation/preview`: `{ assessment, baseline, pinned, candidates, evidence }`; history, project access and current time are supplied by the server. No model execution.

These endpoints require a signed-in account and the normal CSRF protection for POST requests.
