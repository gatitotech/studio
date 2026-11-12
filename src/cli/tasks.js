const MAX_TASK_OUTPUT = 40_000;

function elapsed(task, now = Date.now()) {
  const end = task.finishedAt || now;
  return Math.max(0, Math.round((end - task.startedAt) / 1000));
}

function summarize(text, limit = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function createTaskManager() {
  const tasks = new Map();
  let nextTaskId = 0;

  function track({ name, args = null, summary = '', callId = null, promise, controller = null } = {}) {
    const task = {
      id: `task_${nextTaskId + 1}`,
      name: String(name || 'tool'),
      args,
      summary: summarize(summary),
      callId,
      controller,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      result: null,
      error: null,
      stopRequested: false,
      seen: false,
    };
    nextTaskId += 1;
    tasks.set(task.id, task);
    Promise.resolve(promise).then((result) => {
      task.result = result || null;
      task.finishedAt = Date.now();
      if (task.stopRequested) task.status = 'stopped';
      else task.status = result?.isError ? 'failed' : 'completed';
      task.seen = false;
    }).catch((error) => {
      task.error = error;
      task.finishedAt = Date.now();
      if (task.stopRequested) task.status = 'stopped';
      else task.status = 'failed';
      task.seen = false;
    });
    return task;
  }

  function get(taskId) {
    return tasks.get(String(taskId || '').trim()) || null;
  }

  function list() {
    return [...tasks.values()].sort((left, right) => left.startedAt - right.startedAt);
  }

  function stop(taskId) {
    const task = get(taskId);
    if (!task) return null;
    if (task.status !== 'running') return task;
    task.stopRequested = true;
    task.status = 'stopped';
    task.finishedAt = Date.now();
    try {
      task.controller?.abort();
    } catch {
      // The task may already have exited.
    }
    return task;
  }

  function describe(task, { markSeen = true } = {}) {
    if (!task) return '';
    if (markSeen) task.seen = true;
    const lines = [
      `background task ${task.id} · ${task.status} · ${elapsed(task)}s`,
    ];
    if (task.name) {
      lines.push(`tool: ${task.name}${task.summary ? ` · ${task.summary}` : ''}`);
    }
    if (task.status === 'running') {
      lines.push('', 'The tool is still running. Gatita can keep working, poll this task, or stop it with stop_task.');
    } else if (task.error) {
      lines.push('', `error: ${summarize(task.error.message || task.error, 1_000)}`);
    } else if (task.result?.output) {
      const output = String(task.result.output);
      lines.push('', output.length > MAX_TASK_OUTPUT ? `… earlier output trimmed …\n${output.slice(-MAX_TASK_OUTPUT)}` : output);
      if (task.result.isError) lines.push('', `status: tool failed${task.result.code ? ` (${task.result.code})` : ''}`);
    } else if (task.status === 'completed') {
      lines.push('', '(the tool finished without output)');
    } else if (task.status === 'stopped') {
      lines.push('', 'stopped by request.');
    }
    return lines.join('\n');
  }

  function listText() {
    const items = list();
    if (!items.length) return 'No background tasks.';
    return items.map((task) => {
      const detail = task.summary ? ` · ${task.summary}` : '';
      return `${task.id} · ${task.status} · ${elapsed(task)}s · ${task.name}${detail}`;
    }).join('\n');
  }

  function cleanup() {
    for (const task of tasks.values()) {
      try {
        task.controller?.abort();
      } catch {
        // Cleanup is best effort.
      }
    }
    tasks.clear();
  }

  return {
    track,
    get,
    list,
    stop,
    describe,
    listText,
    cleanup,
  };
}
