import { createServer } from 'node:http';
import { createJBrancher, sameAction } from './index.js';
import { createJevEvaluator } from './jev.js';
import { createOpenWorldLearner } from './discovery.js';
import { findLearnedWorkflows, selectLearnedWorkflow } from './learning.js';

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Create a small, language-agnostic JBrancher decision service.
 *
 * This is intentionally not an OpenAI-compatible model proxy. A caller must
 * submit a bounded candidate set so the service cannot invent executable work.
 * An omitted or empty candidate set is also valid: it represents open-world
 * work and returns an abstention for the caller's frontier actor.
 */
export function createJBrancherServer({
  apiKey = process.env.TYPESAFE_API_KEY,
  model = 'jev-latest',
  endpoint,
  timeoutMs = 5000,
  fetchImpl,
  evaluate,
  learningDirectory,
  learningSource = 'proxy',
  learningCwd = process.cwd(),
  learningAutoPromote = true,
  learningMinimumObservations = 2,
  learningCandidateMinimumObservations = 1,
  learningMinimumSimilarity = 0.8,
  learningAllowVerified = false
} = {}) {
  const evaluator = evaluate ?? (apiKey ? createJevEvaluator({ apiKey, model, endpoint, timeoutMs, fetchImpl }) : undefined);
  const learner = typeof learningDirectory === 'string' && learningDirectory
    ? createOpenWorldLearner({
      directory: learningDirectory,
      source: learningSource,
      cwd: learningCwd,
      autoPromote: learningAutoPromote,
      minimumObservations: learningMinimumObservations,
      candidateMinimumObservations: learningCandidateMinimumObservations,
      minimumSimilarity: learningMinimumSimilarity,
      allowVerified: learningAllowVerified
    })
    : undefined;
  const stats = {
    requestsTotal: 0,
    decisionsTotal: 0,
    episodesRecorded: 0,
    evaluatorCalls: 0,
    workflowRequests: 0,
    unavailable: 0,
    errors: 0,
    learningErrors: 0,
    sources: {}
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, {
          status: 'healthy',
          model,
          evaluatorConfigured: Boolean(evaluator),
          learningConfigured: Boolean(learner)
        });
      }
      if (request.method === 'GET' && url.pathname === '/stats') {
        return sendJson(response, 200, stats);
      }
      if (request.method === 'GET' && url.pathname === '/v1/learning') {
        if (!learner) return sendJson(response, 404, { error: 'Learning is not configured' });
        try {
          return sendJson(response, 200, await learner.snapshot());
        } catch (error) {
          stats.learningErrors += 1;
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/v1/episodes') {
        if (!learner) return sendJson(response, 404, { error: 'Learning is not configured' });
        const input = await readJson(request);
        if (typeof input.task !== 'string' || !input.task.trim()) {
          return sendJson(response, 400, { error: 'task must be a non-empty string' });
        }
        if (!Array.isArray(input.toolCalls)) {
          return sendJson(response, 400, { error: 'toolCalls must be an array' });
        }
        if (input.routeId !== undefined && (typeof input.routeId !== 'string' || !input.routeId)) {
          return sendJson(response, 400, { error: 'routeId must be a non-empty string when provided' });
        }
        for (const call of input.toolCalls) {
          if (!call || typeof call !== 'object'
            || typeof call.toolName !== 'string' || !call.toolName
            || !Object.hasOwn(call, 'input')) {
            return sendJson(response, 400, {
              error: 'each toolCall needs toolName and input'
            });
          }
        }
        const episode = learner.begin({
          task: input.task,
          episodeCwd: input.cwd ?? learningCwd,
          episodeSource: input.source ?? learningSource,
          routeResolution: input.routeResolution ?? 'unmatched',
          metadata: {
            ...(input.metadata ?? {}),
            ...(input.routeId ? { routeId: input.routeId } : {})
          }
        });
        try {
          for (const [index, call] of input.toolCalls.entries()) {
            const toolCallId = call.toolCallId ?? `episode-call-${index}`;
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
          const trace = await episode.finish({
            outcome: input.outcome,
            metadata: input.finishMetadata ?? {}
          });
          const routeSuccessRecorded = trace.outcome === 'success' && input.routeId
            && typeof learner.store.recordRouteSuccess === 'function'
            ? await learner.store.recordRouteSuccess(input.routeId)
            : null;
          const routeFailureRecorded = (trace.outcome === 'failure' || trace.routeResolution === 'failed') && input.routeId
            && typeof learner.store.recordRouteFailure === 'function'
            ? await learner.store.recordRouteFailure(input.routeId, { reason: input.failureReason ?? 'Harness reported learned-route failure' })
            : null;
          stats.episodesRecorded += 1;
          return sendJson(response, 201, {
            trace,
            routeSuccessRecorded: Boolean(routeSuccessRecorded),
            routeFailureRecorded: Boolean(routeFailureRecorded),
            learning: await learner.snapshot()
          });
        } catch (error) {
          stats.learningErrors += 1;
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflow') {
        if (!learner) return sendJson(response, 404, { error: 'Learning is not configured' });
        const input = await readJson(request);
        if (typeof input.task !== 'string' || !input.task.trim()) {
          return sendJson(response, 400, { error: 'task must be a non-empty string' });
        }
        if (!Array.isArray(input.candidateSteps) || input.candidateSteps.some(step => !Array.isArray(step))) {
          return sendJson(response, 400, { error: 'candidateSteps must be an array of candidate arrays' });
        }
        const maxSteps = Number.isSafeInteger(input.maxSteps) && input.maxSteps > 0 ? input.maxSteps : 12;
        if (maxSteps > 100) return sendJson(response, 400, { error: 'maxSteps must be <= 100' });
        const workflowRecords = await learner.store.readRoutes();
        const workflows = findLearnedWorkflows(workflowRecords, input.task, {
          allowVerified: learningAllowVerified
        });
        const matches = workflows.filter(workflow => workflow.actions.length <= maxSteps
          && workflow.actions.every((action, index) => input.candidateSteps[index]
            .some(candidate => sameAction(candidate, action))));
        const selected = selectLearnedWorkflow(matches, workflowRecords);
        stats.requestsTotal += 1;
        stats.workflowRequests += 1;
        if (!selected) {
          return sendJson(response, 200, {
            source: 'abstain',
            action: null,
            actions: [],
            routeResolution: matches.length > 1 ? 'ambiguous' : 'unmatched',
            workflowCandidates: matches.map(workflow => ({ id: workflow.id, stepCount: workflow.actions.length })),
            reason: matches.length > 1 ? 'More than one learned workflow was authorized' : 'No learned workflow was authorized'
          });
        }
        return sendJson(response, 200, {
          source: 'learned',
          routeId: selected.id,
          actions: selected.actions,
          routeResolution: 'learned',
          usage: [],
          reason: 'A proven local workflow matched'
        });
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/decide') {
        return sendJson(response, 404, { error: 'Not found' });
      }

      stats.requestsTotal += 1;
      const input = await readJson(request);
      if (input.candidates !== undefined && !Array.isArray(input.candidates)) {
        return sendJson(response, 400, { error: 'candidates must be an array when provided' });
      }
      const candidates = input.candidates ?? [];

      const brancher = createJBrancher({
        getCandidates: () => candidates,
        learningStore: learner?.store,
        learningSource,
        learningCwd,
        learningAutoPromote,
        learningMinimumObservations,
        learningCandidateMinimumObservations,
        learningMinimumSimilarity,
        learningPromotionMode: learningAllowVerified ? 'verified' : 'safe',
        learningOutcome: learningAllowVerified ? async () => true : undefined,
        evaluate: evaluator ? async context => {
          stats.evaluatorCalls += 1;
          return evaluator(context);
        } : undefined
      });
      const decision = await brancher.decide({
        task: input.task,
        state: input.state,
        history: input.history
      });
      stats.decisionsTotal += 1;
      stats.sources[decision.source] = (stats.sources[decision.source] ?? 0) + 1;
      if (decision.evaluation?.status === 'unavailable') stats.unavailable += 1;
      return sendJson(response, 200, decision);
    } catch (error) {
      stats.errors += 1;
      return sendJson(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : 'Decision service failed' });
    }
  });

  return {
    server,
    stats,
    listen({ host = '127.0.0.1', port = 8787 } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve({ host, port: typeof address === 'object' && address ? address.port : port });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
