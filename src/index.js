import { createEpisodeRecorder, findLearnedActions, findLearnedWorkflows, refreshAndPromoteReadOnly } from './learning.js';

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
  onEvent = () => {},
  learningStore,
  learningSource = 'harness',
  learningCwd = '',
  learningOnlyFallback = true,
  learningAutoPromote = true,
  learningMinimumObservations = 2,
  learningMinimumSimilarity = 0.8,
  learningOutcome
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
  if (learningStore !== undefined && (!learningStore || typeof learningStore.appendTrace !== 'function')) {
    throw new TypeError('learningStore must expose appendTrace()');
  }
  if (typeof learningSource !== 'string' || typeof learningCwd !== 'string') {
    throw new TypeError('learningSource and learningCwd must be strings');
  }
  if (typeof learningOnlyFallback !== 'boolean') throw new TypeError('learningOnlyFallback must be boolean');
  if (typeof learningAutoPromote !== 'boolean') throw new TypeError('learningAutoPromote must be boolean');
  if (!Number.isSafeInteger(learningMinimumObservations) || learningMinimumObservations < 1) {
    throw new TypeError('learningMinimumObservations must be a positive integer');
  }
  if (!Number.isFinite(learningMinimumSimilarity) || learningMinimumSimilarity < 0 || learningMinimumSimilarity > 1) {
    throw new TypeError('Invalid learningMinimumSimilarity');
  }
  if (learningOutcome !== undefined && typeof learningOutcome !== 'function') {
    throw new TypeError('learningOutcome must be a function');
  }

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

    if (learningStore && getCandidates && typeof learningStore.readRoutes === 'function' && candidates.length > 0) {
      try {
        const learned = findLearnedActions(await learningStore.readRoutes(), task)
          .filter(match => candidates.some(candidate => sameAction(candidate, match.action)));
        if (learned.length === 1) {
          return { source: 'learned', action: clone(learned[0].action), routeId: learned[0].id,
            reason: 'A proven local read-only route matched', usage: [] };
        }
      } catch {
        // Learned routing is advisory; the normal candidate/evaluator path remains authoritative.
      }
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

  function shouldRecord(decision) {
    return Boolean(learningStore && (!learningOnlyFallback || decision.source === 'actor'));
  }

  function recordAction(recorder, decision, stepNumber) {
    if (!recorder || !decision.action || typeof decision.action.tool !== 'string') return null;
    const toolCallId = `step-${stepNumber}`;
    recorder.recordToolCall({
      toolCallId,
      toolName: decision.action.tool,
      input: decision.action.args
    });
    return toolCallId;
  }

  async function finishRecorder(recorder, options) {
    if (!recorder || recorder.toolCalls.length === 0) return undefined;
    try {
      const saved = await recorder.finish(options);
      if (saved?.outcome === 'success' && learningAutoPromote
        && typeof learningStore?.refreshCandidates === 'function'
        && typeof learningStore?.promote === 'function') {
        await refreshAndPromoteReadOnly(learningStore, {
          minimumObservations: learningMinimumObservations,
          minimumSimilarity: learningMinimumSimilarity
        });
      }
      return saved;
    } catch {
      // Learning must never turn a successful harness action into a failed step.
      return undefined;
    }
  }

  async function validatedOutcome(context) {
    if (!learningOutcome) return undefined;
    try {
      const result = await learningOutcome({
        task: clone(context.task ?? ''),
        state: clone(context.state ?? {}),
        history: clone(context.history ?? []),
        events: clone(context.events ?? []),
        event: context.event ? clone(context.event) : undefined
      });
      if (result === true) return 'success';
      if (result === false) return 'unknown';
      if (result === 'success' || result === 'unknown' || result === 'failure') return result;
    } catch {
      // Completion validation is advisory to the host harness.
    }
    return undefined;
  }

  async function executeStep(input = {}, recorder) {
    const decision = await decide(input);
    const actionRecorder = shouldRecord(decision) ? recorder : null;
    const toolCallId = recordAction(actionRecorder, decision, input.step ?? 0);
    const event = { step: input.step ?? 0, state: clone(input.state ?? {}), decision: clone(decision) };
    if (decision.action !== null && execute) {
      try {
        event.result = await execute(clone(decision.action), {
          state: clone(input.state ?? {}), task: clone(input.task ?? ''), history: clone(input.history ?? []), signal: input.signal
        });
        if (toolCallId) recorder.recordToolResult({ toolCallId, output: event.result });
      } catch (error) {
        if (toolCallId) recorder.recordToolResult({ toolCallId, isError: true, output: error?.message || String(error) });
        if (decision.source === 'learned' && typeof learningStore?.recordRouteFailure === 'function') {
          await learningStore.recordRouteFailure(decision.routeId, { reason: error?.message || String(error) }).catch(() => {});
        }
        throw error;
      }
    }
    await onEvent(clone(event));
    return event;
  }

  async function step(input = {}) {
    const recorder = learningStore
      ? createEpisodeRecorder({ store: learningStore, task: String(input.task ?? ''), cwd: learningCwd, source: learningSource })
      : null;
    try {
      const event = await executeStep(input, recorder);
      const outcome = await validatedOutcome({ task: input.task, state: input.state, history: input.history, event, events: [event] });
      await finishRecorder(recorder, { ...(outcome ? { outcome } : {}), metadata: { mode: 'step', decisionSource: event.decision.source } });
      return event;
    } catch (error) {
      await finishRecorder(recorder, { outcome: 'unknown', metadata: { mode: 'step' } }).catch(() => {});
      throw error;
    }
  }

  async function replayLearnedWorkflow(input, initialState, initialHistory) {
    if (!learningStore || !getCandidates || !execute || typeof learningStore.readRoutes !== 'function') return null;
    const task = String(input.task ?? '');
    let workflows;
    try {
      workflows = findLearnedWorkflows(await learningStore.readRoutes(), task);
    } catch {
      return null;
    }
    if (workflows.length !== 1 || workflows[0].actions.length > maxSteps) return null;
    if (workflows[0].actions.length > 1 && typeof input.observe !== 'function') return null;

    let state = clone(initialState);
    let history = clone(initialHistory);
    const events = [];
    for (let stepNumber = 0; stepNumber < workflows[0].actions.length; stepNumber++) {
      const action = workflows[0].actions[stepNumber];
      let candidates;
      try {
        candidates = await getCandidates({ state: clone(state), task, history: clone(history), signal: input.signal });
      } catch {
        return null;
      }
      if (!Array.isArray(candidates) || !candidates.some(candidate => sameAction(candidate, action))) return null;
      const decision = { source: 'learned', action: clone(action), routeId: workflows[0].id,
        reason: 'A proven local read-only workflow matched', usage: [] };
      const event = { step: stepNumber, state: clone(state), decision: clone(decision) };
      try {
        event.result = await execute(clone(action), {
          state: clone(state), task, history: clone(history), signal: input.signal
        });
      } catch (error) {
        if (typeof learningStore.recordRouteFailure === 'function') {
          await learningStore.recordRouteFailure(workflows[0].id, { reason: error?.message || String(error) }).catch(() => {});
        }
        return null;
      }
      await onEvent(clone(event));
      events.push(event);
      history = [...history, event];
      if (typeof input.observe !== 'function') break;
      state = clone(await input.observe({ state: clone(state), event: clone(event), history: clone(history) }));
    }
    return { events, state, history };
  }

  async function run(input = {}) {
    let state = clone(input.state ?? {});
    let history = clone(input.history ?? []);
    const events = [];
    const recorder = learningStore
      ? createEpisodeRecorder({ store: learningStore, task: String(input.task ?? ''), cwd: learningCwd, source: learningSource })
      : null;
    try {
      const learnedRun = await replayLearnedWorkflow(input, state, history);
      if (learnedRun) return learnedRun;
      for (let stepNumber = 0; stepNumber < maxSteps; stepNumber++) {
        const event = await executeStep({ ...input, state, history, step: stepNumber }, recorder);
        events.push(event);
        history = [...history, event];
        if (event.decision.action === null || !execute) break;
        if (typeof input.observe !== 'function') break;
        state = clone(await input.observe({ state: clone(state), event: clone(event), history: clone(history) }));
      }
      const outcome = await validatedOutcome({ task: input.task, state, history, events });
      await finishRecorder(recorder, { ...(outcome ? { outcome } : {}), metadata: { mode: 'run', steps: events.length } });
    } catch (error) {
      await finishRecorder(recorder, { outcome: 'unknown', metadata: { mode: 'run', steps: events.length } }).catch(() => {});
      throw error;
    }
    return { events, state, history };
  }

  return { decide, step, run, metadata: {
    minimumProbability, minimumMargin, maxSteps, ruleCount: rules.length,
    learning: Boolean(learningStore), learningAutoPromote, learningOnlyFallback,
    learningOutcomeValidation: Boolean(learningOutcome)
  } };
}

export { sameAction };

/**
 * Wrap an existing actor without changing the surrounding harness loop.
 * The actor's nextAction method becomes the fallback path.
 */
export function withJBrancher(actor, options = {}) {
  if (!actor || typeof actor.nextAction !== 'function') {
    throw new TypeError('withJBrancher requires an actor with nextAction(input)');
  }
  const originalNextAction = actor.nextAction.bind(actor);
  const brancher = createJBrancher({
    ...options,
    actor: input => originalNextAction(input)
  });
  const brancherMethods = new Set(['decide', 'step', 'run']);
  return new Proxy(actor, {
    get(target, property, receiver) {
      if (property === 'nextAction') return input => brancher.decide(input);
      if (property === 'jbrancher') return brancher;
      if (brancherMethods.has(property)) return brancher[property].bind(brancher);
      return Reflect.get(target, property, receiver);
    }
  });
}
