import { getEncoding } from 'js-tiktoken';

const GUARDRAIL = /\b(?:must|shall|never|always|should|only|required|forbidden|unless|before|after|not|cannot|can't|don't|may|ensure|verify|confirm|permission|approval|credential|secret|guardrail|safety|warning|constraint|reject|stop|preserve|avoid|if|when)\b/i;
const IMPERATIVE = /^(?:please\s+)?(?:run|execute|install|delete|remove|create|write|update|read|send|publish|deploy|ask|use|set|keep|follow|return|require|validate|treat|allow|deny|fail|do|make|check|remember)\b/i;
const SENSITIVE_HEADING = /\b(?:safety|security|guardrails?|permissions?|approvals?|constraints?|warnings?|requirements?|instructions?|rules?|limits?|failure|privacy|authentication)\b/i;
const MARKUP = /[`<>|\[\]]|^\s*(?:[-*+]\s|\d+[.)]\s|[=:~-]{3,}\s*$)|(?:https?:\/\/|\b[\w.-]+\/(?:[\w./-]+)|\.(?:sh|py|js|mjs|ts|json|yaml|yml)\b)/i;
const TOKENIZERS = new Map();
function tokenizerFor(encoding) {
  if (!TOKENIZERS.has(encoding)) TOKENIZERS.set(encoding, getEncoding(encoding));
  return TOKENIZERS.get(encoding);
}

export function createMarkdownTokenCounter(encoding = 'cl100k_base') {
  const tokenizer = tokenizerFor(encoding);
  return text => tokenizer.encode(text, [], []).length;
}

/** Conservative segmentation: uncertain syntax/directives stay byte-identical. */
export function markdownSegments(text) {
  if (typeof text !== 'string') throw new TypeError('Markdown must be a string');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const segments = [];
  let index = 0;
  let guardedLevel = null;
  const add = (kind, value) => {
    if (!value) return;
    segments.push({ kind, text: value });
  };
  if (/^(?:---|\+\+\+)\s*$/.test(lines[0]?.trim() ?? '')) {
    const delimiter = lines[0].trim();
    let end = 1;
    while (end < lines.length && lines[end].trim() !== delimiter) end++;
    add('protected', lines.slice(0, Math.min(end + 1, lines.length)).join(''));
    index = Math.min(end + 1, lines.length);
  }
  while (index < lines.length) {
    const line = lines[index];
    const logicalLine = index === 0 ? line.replace(/^\uFEFF/, '') : line;
    if (line.includes('<!--')) {
      let end = index;
      while (end < lines.length && !lines[end].includes('-->')) end++;
      add('protected', lines.slice(index, Math.min(end + 1, lines.length)).join(''));
      index = Math.min(end + 1, lines.length);
      continue;
    }
    // Arbitrary HTML can carry directives outside Markdown headings. Preserve its remainder.
    if (/<\/?[A-Za-z][^>]*>/.test(line)) {
      add('protected', lines.slice(index).join(''));
      break;
    }
    const setext = lines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/);
    if (setext && line.trim() && !/^ {0,3}(?:`{3,}|~{3,}|#{1,6}(?:\s|$))/.test(logicalLine)) {
      const level = setext[1][0] === '=' ? 1 : 2;
      if (guardedLevel !== null && level <= guardedLevel) guardedLevel = null;
      if (SENSITIVE_HEADING.test(line)) guardedLevel = level;
      add('protected', line + lines[index + 1]);
      index += 2;
      continue;
    }
    const heading = logicalLine.match(/^ {0,3}(#{1,6})(?:\s|$)/);
    if (heading) {
      const level = heading[1].length;
      if (guardedLevel !== null && level <= guardedLevel) guardedLevel = null;
      if (SENSITIVE_HEADING.test(line)) guardedLevel = level;
      add('protected', line);
      index++;
      continue;
    }
    const fence = logicalLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const character = fence[1][0];
      const closing = new RegExp(`^ {0,3}${character}{${fence[1].length},}\\s*$`);
      let end = index + 1;
      while (end < lines.length && !closing.test(lines[end].trimEnd())) end++;
      add('protected', lines.slice(index, Math.min(end + 1, lines.length)).join(''));
      index = Math.min(end + 1, lines.length);
      continue;
    }
    if (guardedLevel !== null || /^(?: {4}|\t)/.test(line)) {
      add('protected', line);
      index++;
      continue;
    }
    if (!line.trim()) {
      add('space', line);
      index++;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].trim()
      && !/^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,})/.test(lines[end])
      && !/<!--|<\/?[A-Za-z][^>]*>/.test(lines[end])
      && !/^(?: {4}|\t)/.test(lines[end])) end++;
    const paragraph = lines.slice(index, end).join('');
    const underline = lines.slice(index, end).findIndex(value => /^ {0,3}(?:=+|-+)\s*$/.test(value));
    if (underline > 0 && SENSITIVE_HEADING.test(lines.slice(index, index + underline).join(' '))) {
      guardedLevel = lines[index + underline].trim()[0] === '=' ? 1 : 2;
    }
    const guarded = GUARDRAIL.test(paragraph) || MARKUP.test(paragraph)
      || paragraph.split(/(?<=[.!?])\s+/).some(sentence => IMPERATIVE.test(sentence.trim()))
      || /\b(?:you need to|you are to|steps?|policy|instructions?|commands?)\b/i.test(paragraph);
    add(guarded ? 'protected' : 'prose', paragraph);
    index = end;
  }
  return segments;
}

export function protectedMarkdownSnapshot(text) {
  return markdownSegments(text).filter(segment => segment.kind === 'protected').map(segment => segment.text);
}

const PHRASES = [
  [/\bin order to\b/gi, 'to'],
  [/\bat this point in time\b/gi, 'now'],
  [/\ba large number of\b/gi, 'many'],
  [/\ba small number of\b/gi, 'few'],
  [/\ba total of\s+/gi, ''],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bis able to\b/gi, 'can'],
  [/\b(?:it is worth noting that|as a matter of fact),?\s*/gi, '']
];

/** Local candidate generation; acceptance always requires the separate gates. */
export function compactMarkdown(text) {
  return markdownSegments(text).map(segment => {
    if (segment.kind !== 'prose') return segment.text;
    let value = segment.text;
    for (const [pattern, replacement] of PHRASES) {
      value = value.replace(pattern, match => /^[A-Z]/.test(match) && replacement
        ? replacement[0].toUpperCase() + replacement.slice(1) : replacement);
    }
    // Repeated adjacent explanatory sentences add tokens without adding a fact.
    const sentences = value.match(/[^.!?]+[.!?](?:\s+|$)|[^.!?]+$/g) ?? [value];
    value = sentences.filter((sentence, index) => index === 0
      || sentence.trim() !== sentences[index - 1].trim()).join('');
    const trailingNewlines = segment.text.match(/(?:\r?\n)+$/)?.[0] ?? '';
    value = value.replace(/(?:\r?\n)+$/, '') + trailingNewlines;
    // A rewrite that changes directive classification is rejected locally too.
    const before = protectedMarkdownSnapshot(segment.text);
    const after = protectedMarkdownSnapshot(value);
    return JSON.stringify(before) === JSON.stringify(after) ? value : segment.text;
  }).join('');
}

function vector(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Number.isFinite)
    || value.every(item => item === 0)) throw new Error('Invalid embedding vector');
  return value;
}

export function cosineSimilarity(left, right) {
  vector(left);
  vector(right);
  if (left.length !== right.length) throw new Error('Embedding dimensions differ');
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    a += left[index] ** 2;
    b += right[index] ** 2;
  }
  const similarity = dot / Math.sqrt(a * b);
  if (!Number.isFinite(similarity)) throw new Error('Invalid embedding similarity');
  return Math.max(-1, Math.min(1, similarity));
}

export function createOpenAIEmbeddingVerifier({ apiKey = process.env.OPENAI_API_KEY,
  model = 'text-embedding-3-small', fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (!apiKey?.trim()) throw new Error('OPENAI_API_KEY is required for semantic verification');
  if (typeof model !== 'string' || !model.trim()) throw new Error('An embedding model is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Invalid embedding timeout');
  return async inputs => {
    const results = [];
    for (let offset = 0; offset < inputs.length; offset += 16) {
      const batch = inputs.slice(offset, offset + 16);
      const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: batch, encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`Embedding provider failed (HTTP ${response.status})`);
      const body = await response.json();
      if (!Array.isArray(body.data) || body.data.length !== batch.length) throw new Error('Invalid embedding response');
      const seen = new Set();
      const ordered = Array(batch.length);
      for (const item of body.data) {
        if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= batch.length
          || seen.has(item.index)) throw new Error('Invalid embedding response indexes');
        seen.add(item.index);
        ordered[item.index] = vector(item.embedding);
      }
      results.push(...ordered);
    }
    return results;
  };
}

function chunks(text) {
  const tokenizer = tokenizerFor('cl100k_base');
  const tokens = tokenizer.encode(text, [], []);
  const result = [];
  // Keep each provider input far below the documented 8192-token model limit.
  for (let index = 0; index < tokens.length; index += 2000) {
    const part = tokens.slice(index, index + 2000);
    result.push({ text: tokenizer.decode(part), weight: part.length });
  }
  return result;
}

function mean(vectors, parts) {
  const dimensions = vector(vectors[0]).length;
  const total = Array(dimensions).fill(0);
  let weight = 0;
  vectors.forEach((embedding, index) => {
    vector(embedding);
    if (embedding.length !== dimensions) throw new Error('Embedding dimensions differ');
    weight += parts[index].weight;
    embedding.forEach((value, dimension) => { total[dimension] += value * parts[index].weight; });
  });
  return total.map(value => value / weight);
}

export async function verifyMarkdown({ original, candidate, embed, countTokens = createMarkdownTokenCounter(),
  minimumSimilarity = 0.98 } = {}) {
  if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < 0 || minimumSimilarity > 1) {
    throw new Error('Minimum similarity must be between 0 and 1');
  }
  const inputTokens = countTokens(original);
  const outputTokens = countTokens(candidate);
  const structure = JSON.stringify(protectedMarkdownSnapshot(original)) === JSON.stringify(protectedMarkdownSnapshot(candidate));
  const report = {
    inputTokens, outputTokens, savedTokens: inputTokens - outputTokens,
    reduction: inputTokens ? (inputTokens - outputTokens) / inputTokens : 0,
    structural: { status: structure ? 'passed' : 'failed' },
    semantic: { status: 'skipped', minimumSimilarity }
  };
  if (!structure) return report;
  if (original === candidate) {
    report.semantic = { status: 'passed', reason: 'byte-identical', similarity: 1, minimumSimilarity };
    return report;
  }
  if (typeof embed !== 'function') {
    report.semantic = { status: 'blocked', reason: 'embedding-verifier-required', minimumSimilarity };
    return report;
  }
  if (!original.trim() || !candidate.trim()) {
    report.semantic = { status: 'failed', reason: 'changed-empty-document', minimumSimilarity };
    return report;
  }
  try {
    const before = chunks(original);
    const after = chunks(candidate);
    const embeddings = await embed([...before, ...after].map(part => part.text));
    if (!Array.isArray(embeddings) || embeddings.length !== before.length + after.length) {
      throw new Error('Invalid embedding count');
    }
    const similarity = cosineSimilarity(mean(embeddings.slice(0, before.length), before),
      mean(embeddings.slice(before.length), after));
    report.semantic = { status: similarity >= minimumSimilarity ? 'passed' : 'failed', similarity,
      minimumSimilarity, chunks: { original: before.length, candidate: after.length } };
  } catch {
    // Provider response payloads/errors can contain private document text or credentials.
    report.semantic = { status: 'blocked', reason: 'embedding-verification-failed', minimumSimilarity };
  }
  return report;
}
