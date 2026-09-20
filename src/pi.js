const clone = value => structuredClone(value);

function validateRoute(route, index) {
  if (!route || typeof route !== 'object' || typeof route.id !== 'string' || !route.id.trim()) {
    throw new TypeError(`Invalid Pi route at index ${index}`);
  }
  if (typeof route.match !== 'function' && !(route.match instanceof RegExp) && typeof route.pattern !== 'string') {
    throw new TypeError(`Pi route ${route.id} needs match(), a RegExp, or pattern`);
  }
  if (typeof route.run !== 'function') throw new TypeError(`Pi route ${route.id} needs run()`);
  return route;
}

async function matches(route, input) {
  if (typeof route.match === 'function') return Boolean(await route.match(input));
  if (route.match instanceof RegExp) {
    route.match.lastIndex = 0;
    return route.match.test(input.task);
  }
  return new RegExp(route.pattern, 'i').test(input.task);
}

function routeAction(route) {
  return { tool: 'jbrancher.route', args: { routeId: route.id } };
}

function validateThreshold(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`Invalid ${name}`);
}

/**
 * Create the deterministic-first boundary used by the Pi extension.
 *
 * A single matching route is deterministic and runs directly. When several
 * routes match, Jev may choose only among those routes. An unavailable or
 * uncertain evaluator abstains so Pi's frontier model can handle the prompt.
 */
export function createPiRouter({ routes = [], evaluate, minimumProbability = 0.7,
  minimumMargin = 0.15 } = {}) {
  if (!Array.isArray(routes)) throw new TypeError('routes must be an array');
  routes.forEach(validateRoute);
  if (evaluate !== undefined && typeof evaluate !== 'function') throw new TypeError('evaluate must be a function');
  validateThreshold(minimumProbability, 'minimumProbability');
  validateThreshold(minimumMargin, 'minimumMargin');

  const routeMap = new Map(routes.map(route => [route.id, route]));

  async function findMatches(input) {
    const matched = [];
    for (const route of routes) {
      if (await matches(route, input)) matched.push(route);
    }
    return matched;
  }

  async function decide(input = {}) {
    const task = typeof input.task === 'string' ? input.task : '';
    const state = clone(input.state ?? {});
    const history = clone(input.history ?? []);
    const signal = input.signal;
    const matched = await findMatches({ task, state, history, signal });
    if (matched.length === 0) {
      return { source: 'frontier', action: null, routeId: null, matched: [] };
    }

    if (matched.length === 1) {
      return { source: 'deterministic', action: routeAction(matched[0]),
        routeId: matched[0].id, matched: matched.map(route => route.id) };
    }

    if (!evaluate) {
      return { source: 'frontier', action: null, routeId: null,
        reason: 'Multiple deterministic routes matched without an evaluator',
        matched: matched.map(route => route.id) };
    }

    let verdict;
    try {
      verdict = await evaluate({
        task,
        state: clone(state),
        history: clone(history),
        candidates: matched.map(routeAction),
        signal
      });
    } catch {
      return { source: 'frontier', action: null, routeId: null,
        reason: 'Jev was unavailable while resolving multiple routes',
        matched: matched.map(route => route.id) };
    }

    const scores = verdict?.scores;
    if (!Array.isArray(scores) || scores.length !== matched.length
      || scores.some(score => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      return { source: 'frontier', action: null, routeId: null,
        reason: 'Jev returned malformed route scores', matched: matched.map(route => route.id) };
    }
    const ranked = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1]?.score ?? 0;
    if (best.score < minimumProbability || best.score - second < minimumMargin) {
      return { source: 'frontier', action: null, routeId: null,
        reason: 'Jev was not confident enough to choose a route', matched: matched.map(route => route.id),
        scores: [...scores], usage: clone(verdict?.usage ?? []) };
    }
    const route = matched[best.index];
    return { source: 'jev', action: routeAction(route), routeId: route.id,
      matched: matched.map(item => item.id), score: best.score, scores: [...scores],
      usage: clone(verdict?.usage ?? []) };
  }

  async function execute(decision, input = {}) {
    if (!decision?.routeId || !routeMap.has(decision.routeId)) {
      throw new TypeError('A valid deterministic route decision is required');
    }
    const route = routeMap.get(decision.routeId);
    return route.run({
      task: input.task ?? '',
      state: clone(input.state ?? {}),
      history: clone(input.history ?? []),
      signal: input.signal,
      exec: input.exec
    });
  }

  async function handle(input = {}) {
    const decision = await decide(input);
    if (!decision.routeId) return decision;
    try {
      const result = await execute(decision, input);
      return { ...decision, result };
    } catch (error) {
      return { ...decision, source: 'frontier', routeId: null,
        reason: 'Deterministic route failed; frontier fallback is required',
        error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { decide, execute, handle, routes: routes.map(route => route.id) };
}

export function formatPiResult(result) {
  if (typeof result === 'string') return result;
  if (result === undefined) return '(completed with no output)';
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}
