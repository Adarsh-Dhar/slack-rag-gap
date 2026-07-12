---
title: payments-runbook.md — Staleness Review
status: staleness_review
staleness_score: 0.00
cited_count: 6
follow_up_count: 0
correction_count: 0
created_at: 2026-07-12T08:40:50.860Z
---
---
title: Payments Runbook
status: approved
covers: ["services/payments/index.ts", "services/payments/batch.ts"]
---
# Payments Runbook

## Service Summary

The payments service wraps our processor integration (Stripe) and is the only service allowed to hold processor API keys. It exposes internal endpoints for authorization, capture, refund, and webhook ingestion.

Every state transition is written to an append-only `payment_events` table so any charge's history can be reconstructed without touching the processor's dashboard.

## Alert: High Decline Rate

If the `payments.decline_rate` alert fires (declines exceed 8% of attempts over 10 minutes), first check the Stripe status page for processor-side incidents before assuming a bug on our end.

If Stripe is healthy, pull a sample of declined charges from the `payment_events` table and check the decline codes. A spike concentrated in `insufficient_funds` or `card_declined` is normal customer-side variance, while a spike in `authentication_required` usually means our 3DS challenge flow broke on a recent deploy.

## Alert: Webhook Lag

Stripe webhooks are our source of truth for async events like disputes and delayed bank transfers. If `payments.webhook_lag_seconds` exceeds 300 seconds, check whether the webhook consumer pod is healthy and whether the queue depth is climbing.

Restarting the consumer is safe: it resumes from the last acknowledged event ID, and Stripe replays anything unacknowledged for up to 3 days.

## Reconciliation

A nightly job compares our `payment_events` ledger against Stripe's balance transactions report and pages on-call if the totals diverge by more than $1.

The most common cause of divergence is a webhook that was received but failed to process due to a schema mismatch. Check the dead-letter queue first, since failed webhook handlers land there automatically rather than being silently dropped.

## Refund Escalations

Standard refunds go through the self-service flow and settle in 5-10 business days per Stripe's timeline.

Refunds tied to a dispute or chargeback must go through the payments on-call engineer rather than the self-service path, since disputed charges have separate accounting requirements. Touching them through the normal refund endpoint can leave the ledger inconsistent.

## Email Notification Batching

We batch email notifications because hitting the email provider per-user blows through their rate limit — batching into a 15-min window keeps us under it and lets us dedupe if someone triggers multiple notifications in that window.

