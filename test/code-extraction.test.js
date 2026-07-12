import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeSnippets, extractFilePaths } from '../agent/code-extraction.js';

describe('code-extraction / extractCodeSnippets', () => {
  test('extracts fenced code blocks', () => {
    const text = 'Here is some code:\n```js\nconst x = 1;\nconsole.log(x);\n```\nDone.';
    const snippets = extractCodeSnippets(text);
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0], 'const x = 1;\nconsole.log(x);');
  });

  test('extracts multiple fenced code blocks', () => {
    const text = '```js\nconst a = 1;\n```\n\n```python\nb = 2\n```';
    const snippets = extractCodeSnippets(text);
    assert.equal(snippets.length, 2);
    assert.equal(snippets[0], 'const a = 1;');
    assert.equal(snippets[1], 'b = 2');
  });

  test('extracts inline code', () => {
    const text = 'Run `npm install` to install dependencies.';
    const snippets = extractCodeSnippets(text);
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0], 'npm install');
  });

  test('extracts mixed fenced and inline code', () => {
    const text = 'First run `npm init`, then:\n```bash\nnpm install\n```';
    const snippets = extractCodeSnippets(text);
    assert.equal(snippets.length, 2);
    assert.ok(snippets.includes('npm init'));
    assert.ok(snippets.includes('npm install'));
  });

  test('returns empty array for text with no code', () => {
    const snippets = extractCodeSnippets('No code here.');
    assert.deepEqual(snippets, []);
  });

  test('returns empty array for empty/null input', () => {
    assert.deepEqual(extractCodeSnippets(''), []);
    assert.deepEqual(extractCodeSnippets(null), []);
    assert.deepEqual(extractCodeSnippets(undefined), []);
  });

  test('deduplicates identical inline code', () => {
    const text = 'Run `npm install` and then run `npm install` again.';
    const snippets = extractCodeSnippets(text);
    assert.equal(snippets.length, 1);
  });
});

describe('code-extraction / extractFilePaths', () => {
  test('extracts .js file paths', () => {
    const text = 'Check src/index.js for the main entry point.';
    const paths = extractFilePaths(text);
    assert.ok(paths.includes('src/index.js'));
  });

  test('extracts multiple file paths', () => {
    const text = 'Look at agent/sme-router.js and agent/rag.js for details.';
    const paths = extractFilePaths(text);
    assert.ok(paths.includes('agent/sme-router.js'));
    assert.ok(paths.includes('agent/rag.js'));
  });

  test('extracts paths with various extensions', () => {
    const text = 'Files: config.yaml, main.py, lib.rs, README.md, schema.sql';
    const paths = extractFilePaths(text);
    assert.ok(paths.includes('config.yaml'));
    assert.ok(paths.includes('main.py'));
    assert.ok(paths.includes('lib.rs'));
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('schema.sql'));
  });

  test('returns empty array for text with no file paths', () => {
    const paths = extractFilePaths('No paths here.');
    assert.deepEqual(paths, []);
  });

  test('returns empty array for empty/null input', () => {
    assert.deepEqual(extractFilePaths(''), []);
    assert.deepEqual(extractFilePaths(null), []);
  });
});
