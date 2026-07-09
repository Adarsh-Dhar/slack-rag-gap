# Checkout Service

## Overview

The checkout service owns the cart-to-order transition: it validates cart contents, reserves inventory, charges the customer via the payments service, and emits an `order.created` event once the charge succeeds.

It's a stateless Node.js service behind an internal load balancer, with Postgres as the system of record for orders and Redis for short-lived inventory holds.

## Retry Logic

Calls to downstream services (inventory, payments, tax) use exponential backoff with jitter: 200ms, 400ms, 800ms, capped at 3 attempts. Retries only apply to idempotent GET/HEAD calls and to POST calls that carry an idempotency key.

Blindly retrying a charge could double-bill a customer, so every outbound POST to the payments service includes an `Idempotency-Key` header derived from the order ID.

If a retry lands after the original request actually succeeded upstream, the payments service returns the original response instead of processing a second charge, so retries are safe even across timeouts.

The circuit breaker trips after 5 consecutive failures to a downstream service within a 30-second window. Once tripped, checkout fails fast with a 503 instead of queueing requests behind a dead dependency.

It half-opens after 15 seconds and allows one test request through before fully closing.

## Timeout Budgets

Each downstream call has its own timeout: 2s for inventory checks, 5s for payment authorization, 1s for tax calculation.

The overall checkout request has an 8s hard timeout. If that budget is exhausted, the service rolls back any inventory holds and returns an error rather than leaving the cart in a partial state.

## Common Failure Modes

The most frequent production issue is inventory holds expiring before payment completes, usually when a customer sits on the payment form for more than 2 minutes.

When this happens the checkout service re-validates the hold and, if it expired, re-attempts the reservation once before failing the checkout with a clear "item no longer available" message.

A second recurring issue is duplicate `order.created` events during payments-service failover. Consumers of that event should treat order ID as the dedupe key rather than assuming exactly-once delivery.