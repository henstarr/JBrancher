import { createServer } from 'node:http';
import { createJBrancher } from './index.js';
import { createJevEvaluator } from './jev.js';
import { createOpenWorldLearner } from './discovery.js';

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
 */
export function createJBrancherServer({
  apiKey = process.env.TYPESAFE_API_KEY,
  model = 'jev-1.13.0',
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
  learningMinimumSimilarity = 0.8
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
      minimumSimilarity: learningMinimumSimilarity
    })
    : undefined;
  const stats = {
    requestsTotal: 0,
    decisionsTotal: 0,
    episodesRecorded: 0,
    evaluatorCalls: 0,
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
          metadata: input.metadata ?? {}
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
          stats.episodesRecorded += 1;
          return sendJson(response, 201, {
            trace,
            learning: await learner.snapshot()
          });
        } catch (error) {
          stats.learningErrors += 1;
          throw error;
        }
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/decide') {
        return sendJson(response, 404, { error: 'Not found' });
      }

      stats.requestsTotal += 1;
      const input = await readJson(request);
      if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
        return sendJson(response, 400, { error: 'candidates must be a non-empty array' });
      }

      const brancher = createJBrancher({
        getCandidates: () => input.candidates,
        learningStore: learner?.store,
        learningSource,
        learningCwd,
        learningAutoPromote,
        learningMinimumObservations,
        learningCandidateMinimumObservations,
        learningMinimumSimilarity,
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
