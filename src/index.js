const clone = value => structuredClone(value);

function assertPlainAction(action) {
  if (action === null) return;
  if (!action || typeof action !== 'object' || Array.isArray(action)
    || typeof action.tool !== 'string' || !action.tool
    || !Object.hasOwn(action, 'args')) {
    throw new TypeError('Actions must be null or { tool, args } objects');
  }
  clone(action);
}

function sameAction(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function choose(scores, candidates, minimumProbability, minimumMargin) {
  if (!Array.isArray(scores) || scores.length !== candidates.length || scores.length === 0) return null;
  if (scores.some(score => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) return null;
  const ranked = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1]?.score ?? 0;
  if (best.score < minimumProbability || best.score - second < minimumMargin) return null;
  return { action: clone(candidates[best.index]), score: best.score, index: best.index, scores: [...scores] };
}

/**
 * Create a single decision boundary for a harness.
 *
 * Rules run first. A Jev-compatible evaluator may choose only from the
 * harness-supplied candidates. If rules and evaluation cannot settle the
 * step, the existing actor remains the fallback. The runtime never executes
 * an action unless the caller supplies an executor.
 */
export function createJBrancher({
  rules = [],
  getCandidates,
  evaluate,
  actor,
  execute,
  minimumProbability = 0.7,
  minimumMargin = 0.15,
  maxSteps = 12,
  onEvent = () => {}
} = {}) {
  if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'function')) throw new TypeError('rules must be functions');
  if (getCandidates !== undefined && typeof getCandidates !== 'function') throw new TypeError('getCandidates must be a function');
  if (evaluate !== undefined && typeof evaluate !== 'function') throw new TypeError('evaluate must be a function');
  if (actor !== undefined && typeof actor !== 'function') throw new TypeError('actor must be a function');
  if (execute !== undefined && typeof execute !== 'function') throw new TypeError('execute must be a function');
  if (!Number.isFinite(minimumProbability) || minimumProbability < 0 || minimumProbability > 1
    || !Number.isFinite(minimumMargin) || minimumMargin < 0 || minimumMargin > 1) {
    throw new TypeError('Invalid evaluator thresholds');
  }
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new TypeError('maxSteps must be a positive integer');

  async function decide(input = {}) {
    const state = clone(input.state ?? {});
    const task = clone(input.task ?? '');
    const history = clone(input.history ?? []);
    const signal = input.signal;

    for (const rule of rules) {
      const result = await rule({ state: clone(state), task, history: clone(history), signal });
      if (!result) continue;
      assertPlainAction(result.action);
      return { source: 'rule', action: clone(result.action), reason: result.reason ?? 'rule matched', usage: [] };
    }

    let candidates = [];
    if (getCandidates) {
      candidates = await getCandidates({ state: clone(state), task, history: clone(history), signal });
      if (!Array.isArray(candidates)) throw new TypeError('getCandidates must return an array');
      candidates = candidates.map(candidate => {
        assertPlainAction(candidate);
        return clone(candidate);
      });
    }

    let evaluation = null;
    if (evaluate && candidates.length > 0) {
      try {
        const verdict = await evaluate({ state: clone(state), task, history: clone(history), candidates: clone(candidates), signal });
        evaluation = { scores: clone(verdict?.scores ?? []), usage: clone(verdict?.usage ?? []) };
        const selected = choose(verdict?.scores, candidates, minimumProbability, minimumMargin);
        if (selected) {
          return { source: 'jev', action: selected.action, score: selected.score,
            scores: selected.scores, selected: selected.index, candidates, evaluation, usage: clone(verdict?.usage ?? []) };
        }
      } catch (error) {
        evaluation = { status: 'unavailable', usage: clone(error?.usage ?? []) };
        // Evaluation failure is advisory; the actor remains available.
      }
    }

    if (!actor) return { source: 'abstain', action: null, reason: 'No rule, confident evaluator, or actor was available', evaluation, usage: [] };
    const result = await actor({ state: clone(state), task, history: clone(history), candidates: clone(candidates), signal });
    assertPlainAction(result?.action ?? null);
    return { source: 'actor', action: clone(result?.action ?? null), evaluation, usage: clone(result?.usage ?? []) };
  }

  async function step(input = {}) {
    const decision = await decide(input);
    const event = { step: input.step ?? 0, state: clone(input.state ?? {}), decision: clone(decision) };
    if (decision.action !== null && execute) {
      event.result = await execute(clone(decision.action), {
        state: clone(input.state ?? {}), task: clone(input.task ?? ''), history: clone(input.history ?? []), signal: input.signal
      });
    }
    await onEvent(clone(event));
    return event;
  }

  async function run(input = {}) {
    let state = clone(input.state ?? {});
    let history = clone(input.history ?? []);
    const events = [];
    for (let stepNumber = 0; stepNumber < maxSteps; stepNumber++) {
      const event = await step({ ...input, state, history, step: stepNumber });
      events.push(event);
      history = [...history, event];
      if (event.decision.action === null || !execute) break;
      if (typeof input.observe !== 'function') break;
      state = clone(await input.observe({ state: clone(state), event: clone(event), history: clone(history) }));
    }
    return { events, state, history };
  }

  return { decide, step, run, metadata: { minimumProbability, minimumMargin, maxSteps, ruleCount: rules.length } };
}

export { sameAction };
