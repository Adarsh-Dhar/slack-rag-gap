import log from './logger.js';

/**
 * Generic retry-with-exponential-backoff wrapper for transient failures
 * (LLM completions, Slack API calls, etc). Not used for the ChromaDB
 * healthcheck in app.js, which already has its own bespoke retry loop.
 *
 * @template T
 * @param {() => Promise<T>} fn - Async operation to attempt/retry.
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   isRetryable?: (err: any) => boolean,
 *   label?: string,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(
  fn,
  { retries = 3, baseDelayMs = 500, isRetryable = () => true, label = 'operation' } = {},
) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1); // exponential backoff
      log.warn(
        { module: 'retry', label, attempt, retries, err: err.message, delayMs: delay },
        'Retry after transient failure',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Shared retryability check for OpenAI/GitHub Models client errors:
 * retry on 429 (rate limit), 5xx (server error), and network timeouts.
 * Does NOT retry 4xx client errors (bad request, auth, etc) since retrying
 * those just repeats the same failure.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isRetryableLLMError(err) {
  if (err?.status === 429) return true;
  if (typeof err?.status === 'number' && err.status >= 500) return true;
  return err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.code === 'ENOTFOUND';
}

/**
 * Shared retryability check for Slack Web API errors surfaced via @slack/web-api.
 * Retries on rate limiting and 5xx-class platform errors; does not retry
 * things like invalid_auth or channel_not_found, which won't succeed on retry.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isRetryableSlackError(err) {
  if (err?.code === 'slack_webapi_rate_limited') return true;
  const status = err?.data?.error;
  if (status === 'internal_error' || status === 'service_unavailable' || status === 'fatal_error') return true;
  return err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET';
}
