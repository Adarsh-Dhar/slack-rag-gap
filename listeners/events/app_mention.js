import { assignOwner, loadDocOwners } from '../../agent/doc-owners.js';
import { callLLM } from '../../agent/llm-caller.js';
import log from '../../agent/logger.js';
import { assignProcessOwner, loadProcessOwners } from '../../agent/process-owners.js';
import { getLastAnswerForThread } from '../../agent/rag.js';

/**
 * Parses an ownership command from the text (after the bot @mention is stripped).
 * Returns null if the text doesn't match any ownership command pattern.
 *
 * Supported commands:
 *   assign|set|transfer owner of <doc> to <@user>
 *   who owns <doc>
 *   list [doc] owners
 *
 * @param {string} text - Message text with bot @mention already removed
 * @returns {{ type: 'assign'|'who'|'list', docName?: string, newOwnerId?: string } | null}
 */
export function parseOwnerCommand(text) {
  const assignMatch = text.match(
    /^(?:assign|set|transfer)\s+owner(?:ship)?\s+(?:of|for)\s+(.+?)\s+to\s+<@([A-Z0-9]+)>/i,
  );
  if (assignMatch) {
    return { type: 'assign', docName: assignMatch[1].trim(), newOwnerId: assignMatch[2] };
  }

  const whoMatch = text.match(/^who\s+owns\s+(.+)/i);
  if (whoMatch) {
    return { type: 'who', docName: whoMatch[1].trim() };
  }

  if (/^list\s+(?:doc\s+)?owners/i.test(text.trim())) {
    return { type: 'list' };
  }

  return null;
}

/**
 * Parses a process-owner command from the text (after the bot @mention is
 * stripped). Mirrors parseOwnerCommand's grammar and rules, but for tagging
 * a real engineer to an operational topic (e.g. "checkout", "deploys")
 * instead of to a doc file. Must be checked BEFORE parseOwnerCommand, since
 * "who owns process X" would otherwise be swallowed by the doc "who owns"
 * pattern.
 *
 * Supported commands:
 *   assign|set|transfer process owner of <topic> to <@user> [keywords: a, b, c]
 *   who owns process <topic>
 *   who is (the) process owner (of|for) <topic>
 *   list process owners
 *
 * @param {string} text - Message text with bot @mention already removed
 * @returns {{ type: 'assign'|'who'|'list', topicName?: string, newOwnerId?: string, keywords?: string[] } | null}
 */
export function parseProcessOwnerCommand(text) {
  const assignMatch = text.match(
    /^(?:assign|set|transfer)\s+process\s+owner(?:ship)?\s+(?:of|for)\s+(.+?)\s+to\s+<@([A-Z0-9]+)>(?:\s+keywords?\s*[:=]\s*(.+))?$/i,
  );
  if (assignMatch) {
    const keywords = assignMatch[3]
      ? assignMatch[3]
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean)
      : undefined;
    return { type: 'assign', topicName: assignMatch[1].trim(), newOwnerId: assignMatch[2], keywords };
  }

  const whoMatch =
    text.match(/^who\s+owns\s+process\s+(.+)/i) ||
    text.match(/^who\s+is\s+(?:the\s+)?process\s+owner\s+(?:of|for)\s+(.+)/i);
  if (whoMatch) {
    return { type: 'who', topicName: whoMatch[1].trim() };
  }

  if (/^list\s+process\s+owners/i.test(text.trim())) {
    return { type: 'list' };
  }

  return null;
}

/**
 * Handles the event when the app is mentioned in a Slack conversation.
 * Ownership commands (assign/set/transfer/who/list) are processed here
 * regardless of threading. All other threaded @mentions are deferred to
 * threadReplyCallback (events/thread_reply.js).
 */
export const appMentionCallback = async ({ event, client, logger, say }) => {
  log.info(
    {
      module: 'app_mention',
      ts: event.ts,
      thread_ts: event.thread_ts ?? 'none',
      textPreview: event.text?.slice(0, 80),
    },
    'App mention received',
  );
  try {
    const { channel, text, team, user } = event;
    const thread_ts = event.thread_ts || event.ts;

    // Strip the bot @mention prefix from the text for command parsing
    const cleanText = text.replace(/<@[A-Z0-9]+>\s*/, '').trim();

    // Process-owner commands are checked first — "who owns process X" would
    // otherwise be swallowed by the doc-owner "who owns" pattern below.
    const processOwnerCmd = parseProcessOwnerCommand(cleanText);
    if (processOwnerCmd) {
      if (processOwnerCmd.type === 'assign') {
        const result = assignProcessOwner(
          processOwnerCmd.topicName,
          processOwnerCmd.newOwnerId,
          user,
          processOwnerCmd.keywords,
        );
        await say({ text: result.message, thread_ts });
        return;
      }

      if (processOwnerCmd.type === 'who') {
        const owners = loadProcessOwners();
        const key = processOwnerCmd.topicName.trim().toLowerCase().replace(/\s+/g, '-');
        const entry = owners[key];
        const owner = entry?.owner;
        const response =
          owner && owner.startsWith('U')
            ? `The process owner for *${key}* is <@${owner}>.`
            : `*${key}* has no assigned process owner yet. Use \`assign process owner of ${processOwnerCmd.topicName} to @user\` to set one.`;
        await say({ text: response, thread_ts });
        return;
      }

      if (processOwnerCmd.type === 'list') {
        const owners = loadProcessOwners();
        const entries = Object.entries(owners).filter(([k]) => !k.startsWith('_'));
        const response =
          entries.length > 0
            ? '*Process owners:*\n' +
              entries
                .map(([topic, info]) => {
                  const owner = info.owner && info.owner.startsWith('U') ? `<@${info.owner}>` : '_unassigned_';
                  return `• *${topic}* — ${owner}`;
                })
                .join('\n')
            : 'No process owners have been tagged yet.';
        await say({ text: response, thread_ts });
        return;
      }
    }

    const ownerCmd = parseOwnerCommand(cleanText);

    if (ownerCmd) {
      if (ownerCmd.type === 'assign') {
        const result = assignOwner(ownerCmd.docName, ownerCmd.newOwnerId, user);
        await say({ text: result.message, thread_ts });
        return;
      }

      if (ownerCmd.type === 'who') {
        const owners = loadDocOwners();
        const key = ownerCmd.docName.endsWith('.md') ? ownerCmd.docName : `${ownerCmd.docName}.md`;
        const entry = owners[key];
        const owner = entry?.owner;
        const response =
          owner && owner.startsWith('U')
            ? `The owner of *${key}* is <@${owner}>.`
            : `*${key}* has no assigned owner yet. Use \`assign owner of ${ownerCmd.docName} to @user\` to set one.`;
        await say({ text: response, thread_ts });
        return;
      }

      if (ownerCmd.type === 'list') {
        const owners = loadDocOwners();
        const entries = Object.entries(owners).filter(([k]) => !k.startsWith('_'));
        const response =
          entries.length > 0
            ? '*Document owners:*\n' +
              entries
                .map(([doc, info]) => {
                  const owner = info.owner && info.owner.startsWith('U') ? `<@${info.owner}>` : '_unassigned_';
                  return `• *${doc}* — ${owner}`;
                })
                .join('\n')
            : 'No documents have been registered yet.';
        await say({ text: response, thread_ts });
        return;
      }
    }

    // Skip threaded @mentions — threadReplyCallback handles corrections
    // and follow-ups for replies in threads where the bot already answered.
    // However, if this is the first mention in a thread (no logged answer yet),
    // we should still process it as a regular question.
    if (event.thread_ts) {
      const lastAnswer = getLastAnswerForThread(channel, event.thread_ts);
      if (lastAnswer) {
        return;
      }
    }

    try {
      const streamer = client.chatStream({
        channel: channel,
        recipient_team_id: team,
        recipient_user_id: user,
        thread_ts: thread_ts,
      });

      await callLLM(streamer, [{ role: 'user', content: text }], { channel, thread_ts, source: 'app_mention' });
      await streamer.stop();
    } catch (streamErr) {
      // Fallback: if streaming fails (e.g. missing scope, API error), use
      // say() so the user still gets a response instead of silence.
      log.warn(
        { module: 'app_mention', err: streamErr.message },
        'Streaming failed — falling back to say()',
      );
      const { retrieveContext } = await import('../../agent/rag.js');
      const { getOpenAI } = await import('../../agent/openai-client.js');
      const { withRetry, isRetryableLLMError } = await import('../../agent/with-retry.js');
      const { logAnswer } = await import('../../agent/rag.js');

      const { context, sources, hasResults } = await retrieveContext(text, {
        channel,
        thread_ts,
        source: 'app_mention_fallback',
      });
      const systemContent = hasResults
        ? `Answer only using the provided context. If the context doesn't fully answer the question, say so explicitly rather than guessing. Cite sources by name when relevant.\n\nContext:\n${context}\n\nSources: ${sources.join(', ')}`
        : `No relevant documentation was found for this question. Tell the user you don't have documentation on this topic yet, rather than guessing an answer.`;

      const res = await withRetry(
        () =>
          getOpenAI().chat.completions.create({
            model: 'openai/gpt-4o-mini',
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: text },
            ],
          }),
        { isRetryable: isRetryableLLMError, label: 'app_mention fallback completion' },
      );

      const answer = res.choices[0].message.content;
      await say({ text: answer, thread_ts });
      logAnswer(text, answer, { channel, thread_ts });
    }
  } catch (e) {
    log.error({ module: 'app_mention', err: e.stack ?? e }, 'App mention handler failed');
    await say(`:warning: Something went wrong! (${e.message ?? e})`);
  }
};