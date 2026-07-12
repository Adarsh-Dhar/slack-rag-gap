import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'debug';

/**
 * Shared structured logger for the entire application.
 *
 * Usage:
 *   import log from './agent/logger.js';
 *   log.info({ module: 'ingest', file: 'checkout-service.md' }, 'Ingestion complete');
 *   log.error({ err, module: 'gap-detect', cluster: 'deploy process' }, 'Cluster processing failed');
 *
 * Outputs NDJSON lines to stdout; pipe to your log aggregator (Datadog,
 * CloudWatch, Loki, a file + alertmanager, etc.) at the deployment layer.
 */
const log = pino({
  level: LOG_LEVEL,
  // Include a base `service` field on every log line so you can filter this
  // app's logs apart from other processes writing to the same stream.
  base: { service: 'my-rag-bot' },
  // ISO timestamps are easier to sort and correlate across services than
  // epoch millis, at the cost of a few extra bytes per line.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact any field named `token` or `secret` that might accidentally end
  // up in a logged object — belt-and-braces for env-var leaks.
  redact: ['token', 'secret', 'password', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'GITHUB_TOKEN'],
});

export default log;
