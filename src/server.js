import { createServer } from 'node:http';
import { createJBrancher } from './index.js';
import { createJevEvaluator } from './jev.js';

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
  evaluate
} = {}) {
  const evaluator = evaluate ?? (apiKey ? createJevEvaluator({ apiKey, model, endpoint, timeoutMs, fetchImpl }) : undefined);
  const stats = {
    requestsTotal: 0,
    decisionsTotal: 0,
    evaluatorCalls: 0,
    unavailable: 0,
    errors: 0,
    sources: {}
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, {
          status: 'healthy',
          model,
          evaluatorConfigured: Boolean(evaluator)
        });
      }
      if (request.method === 'GET' && url.pathname === '/stats') {
        return sendJson(response, 200, stats);
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
