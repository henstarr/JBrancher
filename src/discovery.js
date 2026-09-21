import { randomUUID } from 'node:crypto';
import {
  createEpisodeRecorder,
  createLocalLearningStore,
  refreshAndPromoteReadOnly
} from './learning.js';

/**
 * Create the harness-neutral open-world learning boundary.
 *
 * The harness remains responsible for sending unknown work to its frontier
 * actor. This adapter records that actor's lifecycle, writes a redacted local
 * dataset row, and optionally mines/promotes safe routes after completion.
 * It deliberately does not invent or execute actions on its own.
 */
export function createOpenWorldLearner({
  store,
  directory = '.jbrancher',
  source = 'harness',
  cwd = process.cwd(),
  autoPromote = true,
  minimumObservations = 2,
  candidateMinimumObservations = 1,
  minimumSimilarity = 0.8,
  allowVerified = false
} = {}) {
  const learningStore = store ?? createLocalLearningStore({ directory });
  if (!learningStore || typeof learningStore.appendTrace !== 'function') {
    throw new TypeError('store must expose appendTrace()');
  }
  if (typeof source !== 'string' || typeof cwd !== 'string') {
    throw new TypeError('source and cwd must be strings');
  }
  if (typeof autoPromote !== 'boolean') throw new TypeError('autoPromote must be boolean');
  for (const [name, value] of Object.entries({
    minimumObservations,
    candidateMinimumObservations
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < 0 || minimumSimilarity > 1) {
    throw new TypeError('minimumSimilarity must be between 0 and 1');
  }
  if (typeof allowVerified !== 'boolean') throw new TypeError('allowVerified must be boolean');

  const episodes = new Map();

  function begin({
    task,
    episodeCwd = cwd,
    episodeSource = source,
    routeResolution = 'unmatched',
    metadata = {}
  } = {}) {
    if (typeof task !== 'string') throw new TypeError('task must be a string');
    if (typeof episodeCwd !== 'string' || typeof episodeSource !== 'string') {
      throw new TypeError('episodeCwd and episodeSource must be strings');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('metadata must be an object');
    }

    const id = randomUUID();
    const recorder = createEpisodeRecorder({
      store: learningStore,
      task,
      cwd: episodeCwd,
      source: episodeSource,
      metadata: { ...metadata, routeResolution }
    });
    let saved;

    const episode = {
      id,
      task,
      recordToolCall: recorder.recordToolCall,
      recordToolResult: recorder.recordToolResult,
      setMetadata: recorder.setMetadata,
      get toolCalls() { return recorder.toolCalls; },
      async finish(options = {}) {
        if (saved) return saved;
        const { metadata: finishMetadata = {}, ...finishOptions } = options;
        saved = await recorder.finish({
          ...finishOptions,
          metadata: { ...finishMetadata, discoveryEpisodeId: id }
        });
        episodes.delete(id);

        if (saved?.outcome === 'success' && autoPromote
          && typeof learningStore.refreshCandidates === 'function'
          && typeof learningStore.promote === 'function') {
          // Promotion is advisory: a slow or unavailable local learner must
          // never turn a successfully completed frontier episode into a
          // harness failure. The episode remains durable and can be mined by
          // learn() later.
          await refreshAndPromoteReadOnly(learningStore, {
            minimumObservations,
            candidateMinimumObservations,
            minimumSimilarity,
            allowVerified
          }).catch(() => {});
        }
        return saved;
      }
    };
    episodes.set(id, episode);
    return episode;
  }

  async function learn(options = {}) {
    return refreshAndPromoteReadOnly(learningStore, {
      minimumObservations,
      candidateMinimumObservations,
      minimumSimilarity,
      allowVerified,
      ...options
    });
  }

  async function snapshot() {
    const [traces, routes] = await Promise.all([
      typeof learningStore.readTraces === 'function' ? learningStore.readTraces() : [],
      typeof learningStore.readRoutes === 'function' ? learningStore.readRoutes() : []
    ]);
    const outcomes = traces.reduce((counts, trace) => {
      const key = trace.outcome || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    const resolutions = traces.reduce((counts, trace) => {
      const key = trace.routeResolution || trace.metadata?.routeResolution || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    const replayTelemetry = routes.map(route => {
      const successfulReplays = Number.isSafeInteger(route.successfulReplays)
        ? route.successfulReplays : 0;
      const failures = Number.isSafeInteger(route.failures) ? route.failures : 0;
      const replayAttempts = successfulReplays + failures;
      const actionCount = Array.isArray(route.action?.actions)
        ? route.action.actions.length
        : route.action?.toolName ? 1 : 0;
      return {
        id: route.id,
        status: route.status,
        safety: route.safety,
        observations: Number.isSafeInteger(route.observations) ? route.observations : 0,
        actionCount,
        successfulReplays,
        failures,
        replayAttempts,
        replaySuccessRate: replayAttempts === 0 ? null : Number((successfulReplays / replayAttempts).toFixed(3)),
        estimatedFrontierStepsAvoided: successfulReplays * actionCount,
        ...(route.lastReplayAt ? { lastReplayAt: route.lastReplayAt } : {}),
        ...(route.lastFailureAt ? { lastFailureAt: route.lastFailureAt } : {})
      };
    });
    const replayAttempts = replayTelemetry.reduce((total, route) => total + route.replayAttempts, 0);
    const successfulReplays = replayTelemetry.reduce((total, route) => total + route.successfulReplays, 0);
    const replayFailures = replayTelemetry.reduce((total, route) => total + route.failures, 0);
    return {
      directory: learningStore.directory,
      traces: traces.length,
      activeEpisodes: episodes.size,
      routes: routes.length,
      activeRoutes: routes.filter(route => route.status === 'active').length,
      candidates: routes.filter(route => route.status === 'candidate').length,
      quarantinedRoutes: routes.filter(route => route.status === 'quarantined').length,
      successfulReplays,
      replayTelemetry,
      replay: {
        attempts: replayAttempts,
        successes: successfulReplays,
        failures: replayFailures,
        successRate: replayAttempts === 0 ? null : Number((successfulReplays / replayAttempts).toFixed(3)),
        activeRoutesWithReplays: replayTelemetry.filter(route => route.status === 'active' && route.successfulReplays > 0).length,
        estimatedFrontierStepsAvoided: replayTelemetry.reduce((total, route) => total + route.estimatedFrontierStepsAvoided, 0)
      },
      outcomes,
      resolutions
    };
  }

  return {
    store: learningStore,
    begin,
    learn,
    snapshot,
    activeEpisodeIds: () => [...episodes.keys()]
  };
}
