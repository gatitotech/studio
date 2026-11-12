import { ToolError } from './errors.js';

export function createTaskTools({ taskManager }) {
  if (!taskManager) return [];
  return [
    {
      name: 'task_status',
      group: 'read',
      description: 'Check a background task that was moved off the main thread after 20 seconds, or list every background task. Use this while work continues and before deciding that a long command is done.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id from the slow-tool message, for example task_1. Omit to list all tasks.' },
        },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const taskId = String(args.task_id || '').trim();
        if (!taskId) {
          const items = taskManager.list();
          return {
            title: items.length ? `${items.length} background task${items.length === 1 ? '' : 's'}` : 'No background tasks',
            output: taskManager.listText(),
            meta: { tasks: items.length },
          };
        }
        const task = taskManager.get(taskId);
        if (!task) throw new ToolError('bad_arguments', `No background task ${taskId}. Use task_status without a task_id to list tasks.`);
        return {
          title: `Task ${task.id} ${task.status}`,
          output: taskManager.describe(task),
          meta: { taskId: task.id, status: task.status },
        };
      },
    },
    {
      name: 'stop_task',
      group: 'read',
      description: 'Stop a background task by id. Safe to call without approval. Use it when a slow command is no longer needed or is blocking useful work.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id from the slow-tool message, for example task_1.' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const taskId = String(args.task_id || '').trim();
        if (!taskId) throw new ToolError('bad_arguments', 'task_id is required.');
        const task = taskManager.stop(taskId);
        if (!task) throw new ToolError('bad_arguments', `No background task ${taskId}. Use task_status to list tasks.`);
        return {
          title: task.status === 'stopped' ? `Stopped ${task.id}` : `Task ${task.id} ${task.status}`,
          output: taskManager.describe(task, { markSeen: true }),
          meta: { taskId: task.id, status: task.status },
        };
      },
    },
  ];
}
