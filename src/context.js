const clone = value => structuredClone(value);

export function estimateTokens(text, charactersPerToken = 4) {
  if (typeof text !== 'string') throw new TypeError('Context text must be a string');
  if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) throw new TypeError('Invalid charactersPerToken');
  return Math.max(1, Math.ceil(text.length / charactersPerToken));
}

function normalizeItems(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id
      || typeof item.text !== 'string') throw new TypeError(`Invalid context item at index ${index}`);
    const tokens = item.tokens ?? estimateTokens(item.text);
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new TypeError(`Invalid token estimate for ${item.id}`);
    const priority = item.priority ?? 0;
    if (!Number.isFinite(priority)) throw new TypeError(`Invalid priority for ${item.id}`);
    return { ...clone(item), tokens, priority };
  });
}

function validScore(score) {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;
}

/** Select context under a token budget; required items are always retained. */
export async function optimizeContext({ task = '', state = {}, items = [], evaluate,
  maxTokens = 4000, minimumScore = 0.5, requiredIds = [] } = {}) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new TypeError('maxTokens must be a positive integer');
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) throw new TypeError('Invalid minimumScore');
  if (evaluate !== undefined && typeof evaluate !== 'function') throw new TypeError('evaluate must be a function');
  if (!Array.isArray(requiredIds) || requiredIds.some(id => typeof id !== 'string')) throw new TypeError('requiredIds must be strings');

  const normalized = normalizeItems(items);
  const required = new Set(requiredIds);
  const mandatory = normalized.filter(item => item.required === true || required.has(item.id));
  const optional = normalized.filter(item => !mandatory.includes(item));
  const usage = [];
  let evaluationStatus = 'local';
  let scores = optional.map(item => validScore(item.score) ? item.score : Math.max(0, Math.min(1, item.priority)));

  if (evaluate && optional.length > 0) {
    try {
      const verdict = await evaluate({
        task: clone(task), state: clone(state),
        items: optional.map(({ id, text, kind, title, tokens, priority }) => ({ id, text, kind, title, tokens, priority }))
      });
      usage.push(...clone(verdict?.usage ?? []));
      if (Array.isArray(verdict?.scores) && verdict.scores.length === optional.length
        && verdict.scores.every(validScore)) {
        scores = verdict.scores.slice();
        evaluationStatus = 'succeeded';
      } else {
        evaluationStatus = 'unavailable';
      }
    } catch (error) {
      usage.push(...clone(error?.usage ?? []));
      evaluationStatus = 'unavailable';
    }
  }

  const ranked = optional.map((item, index) => ({ item, score: scores[index] }))
    .filter(row => row.score >= minimumScore)
    .sort((left, right) => {
      const density = right.score / right.item.tokens - left.score / left.item.tokens;
      return density || right.score - left.score || right.item.priority - left.item.priority;
    });

  const selected = [];
  let estimatedTokens = 0;
  for (const item of mandatory) {
    selected.push(item);
    estimatedTokens += item.tokens;
  }
  for (const { item } of ranked) {
    if (estimatedTokens + item.tokens > maxTokens) continue;
    selected.push(item);
    estimatedTokens += item.tokens;
  }

  const selectedIds = new Set(selected.map(item => item.id));
  return {
    items: selected.map(clone),
    dropped: normalized.filter(item => !selectedIds.has(item.id)).map(clone),
    scores,
    usage,
    evaluation: { status: evaluationStatus },
    estimatedTokens,
    budget: maxTokens,
    overBudget: estimatedTokens > maxTokens,
    savedTokens: Math.max(0, normalized.reduce((sum, item) => sum + item.tokens, 0) - estimatedTokens)
  };
}
