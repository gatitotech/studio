import { CLIENT_VERSION, DEFAULT_SERVER_URL, USER_AGENT } from '../shared/protocol.js';
import { randomId } from '../shared/util.js';

export class ApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = Number(options.status) || 0;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
    this.requestId = options.requestId;
    this.kind = 'api';
  }
}

function parseErrorPayload(payload, status, requestId) {
  const error = payload?.error ?? payload;
  const code = typeof error === 'object' && error?.code ? String(error.code) : 'request_failed';
  const message = typeof error === 'string'
    ? error
    : String(error?.message || payload?.message || `Request failed with status ${status}.`);
  return new ApiError(code, message, {
    status,
    retryAfter: error?.retryAfter ?? payload?.retryAfter,
    details: error?.details,
    requestId: payload?.requestId || requestId,
  });
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith('event:')) event = rawLine.slice(6).trim();
    else if (rawLine.startsWith('data:')) data.push(rawLine.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const text = data.join('\n');
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: { raw: text } };
  }
}

export function createApiClient({ serverUrl = DEFAULT_SERVER_URL, token = '', timeoutMs = 30_000, chatTimeoutMs = 600_000, fetchImpl } = {}) {
  const baseUrl = String(serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const fetchFn = fetchImpl || fetch;

  const client = {
    baseUrl,
    token,
    setToken(value) {
      client.token = String(value || '');
    },

    async request(path, { method = 'GET', body, signal, timeoutMs: override, headers = {} } = {}) {
      const requestId = randomId('cli');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(override) || timeoutMs));
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const requestHeaders = {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          'x-gatita-client': CLIENT_VERSION,
          'x-request-id': requestId,
          ...headers,
        };
        if (client.token) requestHeaders.authorization = `Bearer ${client.token}`;
        if (body !== undefined) requestHeaders['content-type'] = 'application/json';
        const response = await fetchFn(`${baseUrl}${path}`, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await readBody(response);
        if (!response.ok) throw parseErrorPayload(payload, response.status, requestId);
        return payload;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
        if (controller.signal.aborted) throw new ApiError('timeout', 'The Gatita server took too long to respond.');
        throw new ApiError('network_error', 'Could not reach the Gatita server. Check your connection.');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
    },

    health(options) {
      return client.request('/health', { ...options, timeoutMs: 10_000 });
    },

    getConfig(options) {
      return client.request('/config', options);
    },

    async login(email, password, options = {}) {
      const payload = await client.request('/auth/login', {
        method: 'POST',
        body: { email, password },
        timeoutMs: 30_000,
        ...options,
      });
      if (payload?.token) client.setToken(payload.token);
      return payload;
    },

    logout(options) {
      return client.request('/auth/logout', { method: 'POST', ...options });
    },

    logoutAll(options) {
      return client.request('/auth/logout-all', { method: 'POST', ...options });
    },

    me(options) {
      return client.request('/me', options);
    },

    usage(days = 30, options = {}) {
      return client.request(`/usage?days=${encodeURIComponent(days)}`, options);
    },

    usageResets(options) {
      return client.request('/usage/resets', options);
    },

    consumeReset(options) {
      return client.request('/usage/reset', { method: 'POST', body: {}, ...options });
    },

    adminGrantResets({ email, userId, audience, count = 1, reason = '' } = {}, options = {}) {
      const body = { count, reason };
      if (audience) body.audience = audience;
      if (email) body.email = email;
      if (userId != null) body.userId = userId;
      return client.request('/admin/banked-resets', { method: 'POST', body, ...options });
    },

    adminCreateReset({ audience = 'all', reason = '' } = {}, options = {}) {
      return client.request('/admin/resets', { method: 'POST', body: { audience, reason }, ...options });
    },

    adminListResets(options) {
      return client.request('/admin/resets', options);
    },

    models(options) {
      return client.request('/models', options);
    },

    sessions(options) {
      return client.request('/auth/sessions', options);
    },

    revokeSession(id, options) {
      return client.request(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
    },

    keys(options) {
      return client.request('/auth/keys', options);
    },

    createKey(name, options) {
      return client.request('/auth/keys', { method: 'POST', body: { name }, ...options });
    },

    revokeKey(id, options) {
      return client.request(`/auth/keys/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
    },

    async streamChat({ messages, tools = [], model, reasoning = 'off', maxTokens, sessionId, signal, onEvent = () => {} }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), chatTimeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const requestId = randomId('chat');
      let response;
      try {
        response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            authorization: client.token ? `Bearer ${client.token}` : '',
            'user-agent': USER_AGENT,
            'x-gatita-client': CLIENT_VERSION,
            'x-request-id': requestId,
          },
          body: JSON.stringify({ messages, tools, model, reasoning, maxTokens, sessionId }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
        if (controller.signal.aborted) throw new ApiError('timeout', 'Gatita took too long to respond.');
        throw new ApiError('network_error', 'Could not reach the Gatita server. Check your connection.');
      }

      if (!response.ok) {
        const payload = await readBody(response);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        throw parseErrorPayload(payload, response.status, response.headers.get('x-request-id'));
      }
      if (!response.body) {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        throw new ApiError('empty_stream', 'Gatita returned an empty response.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = null;
      let usage = null;
      let streamError = null;
      let text = '';
      let reasoningText = '';
      let toolCalls = [];

      const handle = (parsed) => {
        if (!parsed) return;
        const { event, data } = parsed;
        if (event === 'text') text += String(data?.delta || '');
        else if (event === 'reasoning') reasoningText += String(data?.delta || '');
        else if (event === 'tool_calls') toolCalls = Array.isArray(data?.toolCalls) ? data.toolCalls : [];
        else if (event === 'usage') usage = data;
        else if (event === 'done') done = data;
        else if (event === 'error') streamError = data;
        onEvent(event, data);
      };

      let readError = null;
      try {
        while (true) {
          const { value, done: readerDone } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            handle(parseSseBlock(block));
          }
          if (readerDone) break;
        }
        if (buffer.trim()) handle(parseSseBlock(buffer));
      } catch (error) {
        readError = error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        try {
          await reader.cancel();
        } catch {
          // Stream already closed.
        }
        reader.releaseLock();
      }

      if (readError) {
        if (readError?.partial) throw readError;
        if (signal?.aborted) {
          const aborted = new ApiError('aborted', 'Cancelled.');
          aborted.partial = { text, reasoning: reasoningText };
          throw aborted;
        }
        if (controller.signal.aborted) {
          const timedOut = new ApiError('timeout', 'Gatita stopped responding.');
          timedOut.partial = { text, reasoning: reasoningText };
          throw timedOut;
        }
        const streamFailure = new ApiError('stream_error', 'The connection to Gatita was interrupted.');
        streamFailure.partial = { text, reasoning: reasoningText };
        throw streamFailure;
      }

      if (streamError) {
        const error = new ApiError(String(streamError.code || 'chat_failed'), String(streamError.message || 'Gatita could not answer.'), {
          retryAfter: streamError.retryAfter,
          requestId,
        });
        error.partial = { text, reasoning: reasoningText };
        throw error;
      }
      return { text, reasoning: reasoningText, toolCalls, usage, done, requestId };
    },
  };

  return client;
}
