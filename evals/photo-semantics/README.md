# Mira photo semantics eval

This is a versioned, synthetic regression dataset for deciding whether a turn
requests, shows, mentions, or rejects a photo. It exists separately from the
runtime coordinator so changing the orchestration cannot silently change the
evaluation contract.

The reported screenshot case is `mira-photo-v1-004`: the user's request asks
for a particular carried photo, while Mira's reply says “就是这张”. The
dataset also keeps the old keyword false positives as explicit negative cases:
“喏” about rain, “给你看” about coffee, and “这张” about a table.

There are two deliberately separate steps:

1. `pnpm evals:photo:validate` performs the offline dataset contract check. It
   never calls TypeSafe and is not evidence of model quality.
2. `pnpm evals:photo:live -- --out tmp/evals/photo-semantics/latest.json` runs
   every case against the configured TypeSafe provider and writes an evidence
   report. The runner uses the real model output; it does not copy expected
   labels into the report.

The `.env` loader is the existing server config loader, so `TYPESAFE_API_KEY`
and `TYPESAFE_DEFAULT_MODEL` are picked up without printing credentials.

`cases.schema.json` describes the dataset contract and
`live-report.schema.json` describes the provider-backed evidence shape. The
generated report is kept under `tmp/`, outside the versioned synthetic dataset.

Dataset changes are versioned. Existing case IDs are stable; changing their
meaning requires a dataset version bump.
