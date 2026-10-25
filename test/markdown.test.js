import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMarkdown, cosineSimilarity, createMarkdownTokenCounter, createOpenAIEmbeddingVerifier,
  protectedMarkdownSnapshot, verifyMarkdown } from '../src/markdown.js';

const sameMeaning = async inputs => inputs.map(() => [1, 0]);
const prose = 'This system is able to process a large number of records. This system is able to process a large number of records.\n';

test('compaction reduces actual tokenizer counts without reformatting protected content', async () => {
  const original = `${prose}\n## Safety\n\nNever publish credentials.\n\n\`\`\`sh\necho unchanged\n\`\`\`\n`;
  const candidate = compactMarkdown(original);
  assert.match(candidate, /This system can process many records/);
  assert.deepEqual(protectedMarkdownSnapshot(candidate), protectedMarkdownSnapshot(original));
  const result = await verifyMarkdown({ original, candidate, embed: sameMeaning });
  assert.equal(result.structural.status, 'passed');
  assert.equal(result.semantic.status, 'passed');
  assert.ok(result.savedTokens > 0);
  assert.equal(result.inputTokens, createMarkdownTokenCounter()(original));
});

const protectedCases = [
  ['YAML metadata', '---\nname: example\ndescription: This system is able to process a large number of records.\n---\n'],
  ['TOML metadata', '+++\nname = "example"\ndescription = "This system is able to process a large number of records."\n+++\n'],
  ['backtick scripts', '```sh\nThis system is able to process a large number of records.\n```\n'],
  ['tilde scripts', '~~~~python\nThis system is able to process a large number of records.\n~~~~\n'],
  ['unclosed fence', '```sh\nThis system is able to process a large number of records.\n'],
  ['indented code', '    This system is able to process a large number of records.\n'],
  ['inline code', 'This system is able to invoke `scripts/run.js` for a large number of records.\n'],
  ['link destination', 'This system is able to process a large number of [records](https://example.com/data).\n'],
  ['relative script path', 'This system is able to invoke scripts/run.js for a large number of records.\n'],
  ['reference link', '[docs]: ../scripts/run.sh "This system is able to process a large number of records."\n'],
  ['constraint paragraph', 'This system must process a large number of records.\n'],
  ['imperative paragraph', 'Run this system in order to process a large number of records.\n'],
  ['conditional paragraph', 'When records arrive, this system is able to process a large number of records.\n'],
  ['multiline HTML comment', '<!--\nThis system is able to process a large number of records.\n\nThis system is able to process a large number of records.\n-->\n'],
  ['HTML directive container', '<details><summary>Safety</summary>\n\nThis system is able to process a large number of records.\n</details>\n'],
  ['CRLF guardrails', '## Safety\r\n\r\nThis system is able to process a large number of records.\r\n'],
  ['Setext safety heading', 'Safety\n======\n\nThis system is able to process a large number of records.\n'],
  ['Setext permissions heading', 'Permissions\n-----------\n\nThis system is able to process a large number of records.\n'],
  ['BOM-prefixed guardrail heading', '\uFEFF## Safety\n\nThis system is able to process a large number of records.\n'],
  ['fence containing Setext-looking code', '```\n---\nThis system is able to process a large number of records.\n```\n']
];
for (const [name, original] of protectedCases) {
  test(`preserves ${name} byte-for-byte`, async () => {
    assert.equal(compactMarkdown(original), original);
    const result = await verifyMarkdown({ original, candidate: original.replace('large', 'small'), embed: sameMeaning });
    assert.equal(result.structural.status, 'failed');
    assert.equal(result.semantic.status, 'skipped');
  });
}

test('guarded sections end at a sibling heading while nested content stays protected', () => {
  const original = `## Safety\n\n${prose}\n### Detail\n\n${prose}\n## Overview\n\n${prose}`;
  const candidate = compactMarkdown(original);
  assert.equal(candidate.slice(0, candidate.indexOf('## Overview')), original.slice(0, original.indexOf('## Overview')));
  assert.match(candidate.slice(candidate.indexOf('## Overview')), /can process many records/);
});

test('filler removal preserves the newline before an adjacent fence', async () => {
  const original = `${prose}\`\`\`sh\necho ok\n\`\`\`\n`;
  const candidate = compactMarkdown(original);
  assert.match(candidate, /\n```sh/);
  assert.deepEqual(protectedMarkdownSnapshot(candidate), protectedMarkdownSnapshot(original));
});

test('unchanged content labels the byte-identity shortcut instead of a provider call', async () => {
  let called = false;
  const result = await verifyMarkdown({ original: prose, candidate: prose, embed: async () => { called = true; } });
  assert.equal(result.semantic.reason, 'byte-identical');
  assert.equal(called, false);
});

test('changed documents block without an embedding verifier and fail low similarity', async () => {
  const candidate = compactMarkdown(prose);
  assert.equal((await verifyMarkdown({ original: prose, candidate })).semantic.status, 'blocked');
  assert.equal((await verifyMarkdown({ original: prose, candidate, embed: async () => [[1, 0], [0, 1]] })).semantic.status, 'failed');
  assert.equal((await verifyMarkdown({ original: prose, candidate, embed: async () => [[1, 0], [NaN, 1]] })).semantic.status, 'blocked');
});

test('empty changed documents and invalid thresholds do not pass', async () => {
  assert.equal((await verifyMarkdown({ original: 'The product is fast.', candidate: '', embed: sameMeaning })).semantic.status, 'failed');
  await assert.rejects(() => verifyMarkdown({ original: prose, candidate: prose, minimumSimilarity: NaN }));
  await assert.rejects(() => verifyMarkdown({ original: prose, candidate: prose, minimumSimilarity: 1.1 }));
});

test('long documents are chunked under the embedding input limit', async () => {
  const original = `The product is able to process records.\n`.repeat(900);
  const candidate = compactMarkdown(original);
  let inputCount = 0;
  const count = createMarkdownTokenCounter();
  const result = await verifyMarkdown({ original, candidate, embed: async inputs => {
    inputCount = inputs.length;
    assert.ok(inputs.every(input => count(input) <= 2001));
    return sameMeaning(inputs);
  } });
  assert.equal(result.semantic.status, 'passed');
  assert.ok(inputCount > 2);
});

test('token counting handles Unicode and special-token-looking source literally', () => {
  const count = createMarkdownTokenCounter();
  assert.ok(count('こんにちは 🌍') > 0);
  assert.ok(count('<|endoftext|>') > 0);
  assert.throws(() => createMarkdownTokenCounter('unknown-encoding'));
});

test('OpenAI embeddings use the selected model, bounded batches, and original response indexes', async () => {
  const calls = [];
  const embed = createOpenAIEmbeddingVerifier({ apiKey: 'private-test-key', model: 'text-embedding-3-small', fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, ...request });
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    return { ok: true, json: async () => ({ data: request.input.map((text, index) => ({ index, embedding: [Number(text) + 1, 1] })).reverse() }) };
  } });
  const result = await embed(Array.from({ length: 18 }, (_, index) => String(index)));
  assert.deepEqual(result.map(item => item[0]), Array.from({ length: 18 }, (_, index) => index + 1));
  assert.deepEqual(calls.map(call => call.input.length), [16, 2]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0].model, 'text-embedding-3-small');
});

test('OpenAI response failures and malformed vectors fail closed without provider payloads', async () => {
  assert.throws(() => createOpenAIEmbeddingVerifier({ apiKey: '' }), /OPENAI_API_KEY/);
  const embed = createOpenAIEmbeddingVerifier({ apiKey: 'key', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'PRIVATE_DOCUMENT' }) });
  await assert.rejects(() => embed(['source']), error => /429/.test(error.message) && !/PRIVATE_DOCUMENT/.test(error.message));
  for (const data of [[], [{ index: 1, embedding: [1, 0] }], [{ index: 0, embedding: [0, 0] }], [{ index: 0, embedding: [1, Infinity] }]]) {
    const invalid = createOpenAIEmbeddingVerifier({ apiKey: 'key', fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) });
    await assert.rejects(() => invalid(['source']));
  }
  const report = await verifyMarkdown({ original: prose, candidate: compactMarkdown(prose), embed: async () => { throw new Error('PRIVATE_DOCUMENT_KEY'); } });
  assert.equal(report.semantic.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DOCUMENT_KEY/);
  assert.throws(() => cosineSimilarity([1, 0], [1]));
});
