export class ToolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.publicMessage = options.publicMessage || message;
    this.details = options.details;
  }
}

export function toToolError(error) {
  if (error instanceof ToolError) return error;
  if (error?.code === 'ENOENT') return new ToolError('not_found', 'That file or directory does not exist.');
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new ToolError('permission_denied', 'Permission was denied for that path.');
  }
  return new ToolError('tool_failed', String(error?.message || 'Tool failed.').slice(0, 500));
}
