export const PROTOCOL_VERSION = 1;
export const API_VERSION = 'v1';
export const API_PREFIX = `/${API_VERSION}`;
// The hosted service has one public Studio address; clients cannot override it.
export const DEFAULT_STUDIO_PATH = '/studio';
export const DEFAULT_SERVER_URL = `https://api.gatita.tech${DEFAULT_STUDIO_PATH}`;

export const CLIENT_NAME = 'gatita-studio';
export const CLIENT_VERSION = '1.0.0';
export const USER_AGENT = `${CLIENT_NAME}/${CLIENT_VERSION}`;

export const EVENT = Object.freeze({
  START: 'start',
  REASONING: 'reasoning',
  TEXT: 'text',
  TOOL_CALL_DELTA: 'tool_call_delta',
  TOOL_CALLS: 'tool_calls',
  USAGE: 'usage',
  NOTICE: 'notice',
  DONE: 'done',
  ERROR: 'error',
});

export const ERROR_CODE = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  ACCOUNT_BANNED: 'account_banned',
  QUOTA_EXCEEDED: 'quota_exceeded',
  RATE_LIMITED: 'rate_limited',
  MODEL_NOT_FOUND: 'model_not_found',
  MODEL_LOCKED: 'model_locked',
  TOOLS_UNSUPPORTED: 'tools_unsupported',
  VISION_UNSUPPORTED: 'vision_unsupported',
  REASONING_UNSUPPORTED: 'reasoning_unsupported',
  CONTEXT_LENGTH: 'context_length',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  INFERENCE_NOT_CONFIGURED: 'inference_not_configured',
  INTERNAL: 'internal_error',
  ABORTED: 'aborted',
});

export const DEFAULT_TIMEOUTS = Object.freeze({
  requestMs: 30_000,
  chatMs: 300_000,
  loginMs: 30_000,
});

export const AGENT_LIMITS = Object.freeze({
  maxSteps: 50,
  maxSubagentSteps: 16,
  maxToolCallsPerStep: 16,
  maxMessages: 400,
  maxTools: 96,
  maxMessageBytes: 512 * 1024,
  maxBodyBytes: 16 * 1024 * 1024,
  maxImagesPerRequest: 8,
  maxImageBytes: 5 * 1024 * 1024,
});

export const FEATURES = Object.freeze({
  chat: true,
  tools: true,
  reasoning: true,
  vision: true,
  computerUse: true,
  mcp: true,
  plugins: true,
  skills: true,
  folders: true,
  usageLimits: true,
});
