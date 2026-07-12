/**
 * Extracts code snippets from Slack message text. Slack code blocks use
 * triple backticks (```...```) and inline code uses single backticks (`...`).
 *
 * @param {string} text - raw Slack message text
 * @returns {string[]} array of extracted code snippets (without the backtick wrappers)
 */
export function extractCodeSnippets(text) {
  if (!text) return [];

  const snippets = [];
  const fencedRanges = [];

  // Match fenced code blocks (```) using string search
  const fenceMarker = '```';
  let pos = 0;
  while (true) {
    const openIdx = text.indexOf(fenceMarker, pos);
    if (openIdx === -1) break;

    const afterOpen = openIdx + fenceMarker.length;
    const lineEnd = text.indexOf('\n', afterOpen);
    const contentStart = lineEnd !== -1 ? lineEnd + 1 : afterOpen;

    const closeIdx = text.indexOf(fenceMarker, contentStart);
    if (closeIdx === -1) break;

    const code = text.slice(contentStart, closeIdx).trim();
    if (code) snippets.push(code);

    fencedRanges.push([openIdx, closeIdx + fenceMarker.length]);
    pos = closeIdx + fenceMarker.length;
  }

  // Match inline code (`...`) — skip any that fall within a fenced range
  const inlineRegex = /`([^`]+)`/g;
  for (const match of text.matchAll(inlineRegex)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // Skip if this match overlaps with a fenced block
    const inFenced = fencedRanges.some(([start, end]) => matchStart >= start && matchEnd <= end);
    if (inFenced) continue;

    const code = (match[1] ?? '').trim();
    if (code && !snippets.includes(code)) {
      snippets.push(code);
    }
  }

  return snippets;
}

/**
 * Extracts file path mentions from Slack message text. Looks for common
 * patterns like paths ending in .js, .ts, .py, .go, etc. preceded by
 * whitespace, quotes, or backticks.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractFilePaths(text) {
  if (!text) return [];
  const pathRegex =
    /(?:^|[\s,;:!"'`/])([\w./-]+\.(?:js|ts|jsx|tsx|py|go|rs|java|rb|sh|yaml|yml|json|md|sql))(?=$|[\s,;:!"'`])/gm;
  const paths = new Set();
  for (const match of text.matchAll(pathRegex)) {
    paths.add(match[1]);
  }
  return [...paths];
}
