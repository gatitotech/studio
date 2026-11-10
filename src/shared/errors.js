import { redactSecrets } from './util.js';

export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = Number(options.status) || 400;
    this.publicMessage = options.publicMessage || message;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
    this.expose = options.expose !== false;
    if (options.cause) this.cause = options.cause;
  }
}

export class AbortError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'AbortError';
    this.code = 'aborted';
  }
}

export function isAbortError(error) {
  return Boolean(error) && (
    error.name === 'AbortError'
    || error.code === 'ABORT_ERR'
    || error.code === 'aborted'
    || error.code === 'cancelled'
  );
}

export function toPublicError(error, fallbackMessage = 'Something went wrong.') {
  if (error instanceof AppError && error.expose) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return { code: 'internal_error', message: fallbackMessage };
}

export function logServerError(error, context = {}) {
  const safe = {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code,
    stack: error instanceof Error ? redactSecrets(error.stack || '') : undefined,
  };
  console.error(JSON.stringify(safe));
}
