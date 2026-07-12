---
title: Deploy Process
status: approved
covers: ["ci/deploy.yml", "ci/canary.sh", "services/deploy/index.ts"]
---
# Deploy Process

## Overview

All services deploy through the same pipeline: merge to `main` triggers a build, the build runs the full test suite and a container image push, and then a canary rollout takes over.

There is no manual "click to deploy" step in normal operation; deploys happen automatically on merge, which is why PR review and CI green status are the real gates.

## Canary Rollout

New images roll out to 5% of pods first and sit there for 10 minutes while error rate and p99 latency are compared against the previous version's baseline.

If error rate stays within 1.5x baseline, the rollout proceeds automatically to 25%, then 50%, then 100%, each stage separated by a 10-minute bake period. Any stage that breaches the error-rate threshold triggers an automatic rollback to the last known-good image.

## Manual Rollback

If an issue is caught after full rollout that the canary didn't catch, run `deploy rollback <service>` from the deploy bot in Slack, which redeploys the previous image tag immediately without going through canary stages again.

Manual rollback is intentionally fast-and-blunt: use it first to stop the bleeding, then investigate root cause afterward rather than trying to diagnose mid-incident.

## Database Migrations

Migrations are decoupled from application deploys and must be backward-compatible with both the previous and next version of the code, since canary means old and new code run simultaneously against the same database for the bake period.

Additive changes (new nullable columns, new tables) are safe to ship in the same PR as the code that uses them.

Destructive changes (dropping columns, renaming tables) require a two-step process: ship the code that stops using the old column first, confirm it's fully rolled out, and only then ship the migration that drops it.

## Feature Flags

Risky changes should ship behind a feature flag rather than relying on canary alone, since canary only protects against crashes and latency regressions, not subtle business-logic bugs that won't show up in error rates.

Flags are managed through LaunchDarkly and can be toggled per-environment without a new deploy.