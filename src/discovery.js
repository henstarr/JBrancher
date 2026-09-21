import { randomUUID } from 'node:crypto';
import {
  createEpisodeRecorder,
  createLocalLearningStore,
  refreshAndPromoteReadOnly,
  summarizeTraceUsage
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

  /**
   * Ingest one completed frontier trajectory without exposing the recorder
   * lifecycle to a harness adapter. The harness still owns execution and the
   * outcome; this helper only durably records, redacts, and mines the episode.
   */
  async function recordEpisode({
    task,
    episodeCwd = cwd,
    episodeSource = source,
    routeResolution = 'unmatched',
    metadata = {},
    toolCalls = [],
    outcome,
    finishMetadata = {}
  } = {}) {
    if (!Array.isArray(toolCalls)) throw new TypeError('toolCalls must be an array');
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object' || typeof call.toolName !== 'string' || !call.toolName) {
        throw new TypeError('Each toolCall must include a non-empty toolName');
      }
    }
    const episode = begin({ task, episodeCwd, episodeSource, routeResolution, metadata });
    try {
      for (const [index, call] of toolCalls.entries()) {
        const toolCallId = call.toolCallId ?? `frontier-call-${index}`;
        episode.recordToolCall({
          toolCallId,
          toolName: call.toolName,
          input: call.input,
          context: call.context
        });
        if (Object.hasOwn(call, 'ok') || Object.hasOwn(call, 'output') || Object.hasOwn(call, 'content')) {
          episode.recordToolResult({
            toolCallId,
            isError: call.ok === false,
            output: call.output ?? call.content
          });
        }
      }
      return await episode.finish({ outcome, metadata: finishMetadata });
    } catch (error) {
      await episode.finish({
        outcome: 'failure',
        metadata: { ...finishMetadata, error: redactText(error?.message || String(error), 500) }
      }).catch(() => {});
      throw error;
    }
  }

  /**
   * Run one unknown request through a harness frontier actor while recording
   * the complete episode. The frontier still owns execution; this helper only
   * supplies lifecycle hooks and persists the redacted result.
   *
   * `outcome` may be a literal status or an async resolver receiving the
   * frontier result. Returning the frontier result unchanged would make this
   * helper convenient for adapters, so the saved episode is returned alongside
   * it rather than being hidden in the local store.
   */
  async function runFrontier({
    task,
    frontier,
    episodeCwd = cwd,
    episodeSource = source,
    routeResolution = 'unmatched',
    metadata = {},
    outcome,
    finishMetadata = {}
  } = {}) {
    if (typeof frontier !== 'function') throw new TypeError('frontier must be a function');
    if (outcome !== undefined && typeof outcome !== 'function'
      && !['success', 'unknown', 'failure'].includes(outcome)
      && outcome !== true && outcome !== false) {
      throw new TypeError('outcome must be success, unknown, failure, true, false, or a function');
    }
    if (finishMetadata !== undefined && (typeof finishMetadata !== 'object' || finishMetadata === null
      || Array.isArray(finishMetadata))) {
      throw new TypeError('finishMetadata must be an object');
    }

    const episode = begin({ task, episodeCwd, episodeSource, routeResolution, metadata });
    const recordContext = {
      task,
      episode,
      recordToolCall: episode.recordToolCall,
      recordToolResult: episode.recordToolResult,
      setMetadata: episode.setMetadata
    };

    function normalizeOutcome(value) {
      if (value === true) return 'success';
      if (value === false) return 'unknown';
      return ['success', 'unknown', 'failure'].includes(value) ? value : undefined;
    }

    try {
      const result = await frontier(recordContext);
      const resolvedOutcome = normalizeOutcome(typeof outcome === 'function'
        ? await outcome({ result, episode })
        : outcome);
      const saved = await episode.finish({
        ...(resolvedOutcome ? { outcome: resolvedOutcome } : {}),
        metadata: finishMetadata
      });
      return { result, episode: saved };
    } catch (error) {
      await episode.finish({
        outcome: 'failure',
        metadata: {
          ...finishMetadata,
          error: error?.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500)
        }
      }).catch(() => {});
      throw error;
    }
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
      const observedUsage = route.usage && typeof route.usage === 'object'
        ? route.usage : summarizeTraceUsage([]);
      const observations = Number.isSafeInteger(route.observations) ? route.observations : 0;
      const averageTokensPerObservation = observations > 0
        ? observedUsage.totalTokens / observations : 0;
      return {
        id: route.id,
        status: route.status,
        safety: route.safety,
        observations,
        actionCount,
        observedUsage,
        successfulReplays,
        failures,
        replayAttempts,
        replaySuccessRate: replayAttempts === 0 ? null : Number((successfulReplays / replayAttempts).toFixed(3)),
        estimatedFrontierStepsAvoided: successfulReplays * actionCount,
        estimatedProviderTokensAvoided: Number((successfulReplays * averageTokensPerObservation).toFixed(3)),
        ...(route.lastReplayAt ? { lastReplayAt: route.lastReplayAt } : {}),
        ...(route.lastFailureAt ? { lastFailureAt: route.lastFailureAt } : {})
      };
    });
    const replayAttempts = replayTelemetry.reduce((total, route) => total + route.replayAttempts, 0);
    const successfulReplays = replayTelemetry.reduce((total, route) => total + route.successfulReplays, 0);
    const replayFailures = replayTelemetry.reduce((total, route) => total + route.failures, 0);
    const usage = summarizeTraceUsage(traces);
    const estimatedProviderTokensAvoided = Number(replayTelemetry
      .reduce((total, route) => total + route.estimatedProviderTokensAvoided, 0).toFixed(3));
    const estimatedBaselineEquivalentProviderTokens = usage.totalTokens + estimatedProviderTokensAvoided;
    const estimatedProviderTokenReduction = estimatedBaselineEquivalentProviderTokens > 0
      ? Number((estimatedProviderTokensAvoided / estimatedBaselineEquivalentProviderTokens).toFixed(3)) : 0;
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
        estimatedFrontierStepsAvoided: replayTelemetry.reduce((total, route) => total + route.estimatedFrontierStepsAvoided, 0),
        estimatedProviderTokensAvoided
      },
      economics: {
        recordedProviderTokens: usage.totalTokens,
        estimatedProviderTokensAvoided,
        estimatedPairedProviderTokensSaved: estimatedProviderTokensAvoided,
        estimatedBaselineEquivalentProviderTokens,
        estimatedProviderTokenReduction,
        successfulReplays
      },
      outcomes,
      resolutions,
      usage
    };
  }

  return {
    store: learningStore,
    begin,
    recordEpisode,
    runFrontier,
    learn,
    snapshot,
    activeEpisodeIds: () => [...episodes.keys()]
  };
}
