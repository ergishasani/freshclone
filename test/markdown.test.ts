import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBlocks } from '../src/markdown.js';

test('extracts selected shell fences with exact command text and source lines', () => {
  const markdown = [
    '# Example',
    '',
    '<!-- freshclone:install -->',
    '```sh',
    'npm ci',
    "echo 'installed'",
    '```',
    '',
    '<!-- freshclone:start -->',
    '',
    '```bash',
    'npm start',
    '```',
  ].join('\n');

  assert.deepEqual(
    [...extractBlocks(markdown).values()],
    [
      { id: 'install', command: "npm ci\necho 'installed'", line: 5 },
      { id: 'start', command: 'npm start', line: 12 },
    ],
  );
});

test('never executes unmarked fences or markers demonstrated inside code', () => {
  const markdown = [
    '```sh',
    'echo unselected',
    '```',
    '',
    '````markdown',
    '<!-- freshclone:fake -->',
    '```sh',
    'echo example-only',
    '```',
    '````',
    '',
    '<!-- freshclone:real -->',
    '```shell',
    'echo selected',
    '```',
  ].join('\n');

  assert.deepEqual([...extractBlocks(markdown).keys()], ['real']);
  assert.equal(extractBlocks(markdown).get('real')?.command, 'echo selected');
});

test('finds marked fences inside Markdown containers', () => {
  const markdown = '> <!-- freshclone:quoted -->\n>\n> ```sh\n> echo hello\n> ```\n';
  assert.deepEqual(extractBlocks(markdown).get('quoted'), {
    id: 'quoted',
    command: 'echo hello',
    line: 4,
  });
});

test('reports duplicate markers even when the commands differ', () => {
  const markdown =
    '<!-- freshclone:install -->\n```sh\nnpm ci\n```\n\n<!-- freshclone:install -->\n```sh\nnpm install\n```';
  assert.throws(() => extractBlocks(markdown), /Duplicate FreshClone block "install".*line 6/);
});

test('requires markers to immediately precede their command', () => {
  assert.throws(() => extractBlocks('<!-- freshclone:install -->'), /must immediately precede/);
  assert.throws(
    () => extractBlocks('<!-- freshclone:install -->\n\nRun this first.\n\n```sh\nnpm ci\n```'),
    /must immediately precede/,
  );
});

test('rejects unsupported languages and whitespace-only commands', () => {
  assert.throws(
    () => extractBlocks("<!-- freshclone:setup -->\n```js\nconsole.log('hello')\n```"),
    /must use a sh, bash, or shell/,
  );
  assert.throws(
    () => extractBlocks('<!-- freshclone:setup -->\n```\nnpm ci\n```'),
    /must use a sh/,
  );
  assert.throws(() => extractBlocks('<!-- freshclone:setup -->\n```sh\n  \n```'), /is empty/);
});

test('rejects malformed FreshClone IDs instead of silently skipping them', () => {
  assert.throws(
    () => extractBlocks('<!-- freshclone:bad id -->\n```sh\necho hi\n```'),
    /Invalid FreshClone marker/,
  );
  assert.throws(
    () => extractBlocks('<!-- freshclone:--help -->\n```sh\necho hi\n```'),
    /Invalid FreshClone marker/,
  );
});

test('handles CRLF readmes without changing reported line numbers', () => {
  const blocks = extractBlocks(
    '# Windows\r\n\r\n<!-- freshclone:install -->\r\n```sh\r\nnpm ci\r\n```\r\n',
  );
  assert.equal(blocks.get('install')?.line, 5);
  assert.equal(blocks.get('install')?.command, 'npm ci');
});
