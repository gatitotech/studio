import { ToolError } from './errors.js';

export function createGoalTool({ goalManager }) {
  if (!goalManager) return null;
  return {
    name: 'goal',
    group: 'todo',
    description: 'Check, complete, or block the active /goal. Call action="complete" only after every goal requirement is verified. Call action="blocked" only when you genuinely need human input; ask the user with the ask tool first when possible.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'complete', 'blocked'], description: 'What to do with the goal.' },
        summary: { type: 'string', description: 'Required for complete or blocked: what was finished, or exactly what human input is needed.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const action = String(args.action || 'status').trim().toLowerCase();
      const goal = goalManager.get();
      if (!goal) throw new ToolError('no_goal', 'No goal is set for this chat.');
      if (action === 'status') {
        return {
          title: `Goal ${goal.status}`,
          output: [
            `status: ${goal.status}`,
            `goal: ${goal.text}`,
            goal.summary ? `summary: ${goal.summary}` : '',
          ].filter(Boolean).join('\n'),
          meta: { status: goal.status },
        };
      }
      if (goal.status !== 'active') {
        throw new ToolError('goal_closed', `This goal is already ${goal.status}. Do not complete or block it again.`);
      }
      const summary = String(args.summary || '').trim();
      if (!summary) throw new ToolError('bad_arguments', 'summary is required for complete or blocked.');
      if (action === 'complete') {
        if (!goalManager.complete(summary)) {
          throw new ToolError('goal_incomplete', 'The goal could not be completed. Finish or cancel every pending todo item first, then call goal action="complete" again.');
        }
        return {
          title: 'Goal complete',
          output: `The goal is marked complete.\n\n${summary}`,
          meta: { status: 'complete' },
        };
      }
      if (action === 'blocked') {
        if (!goalManager.block(summary)) throw new ToolError('goal_closed', 'The goal could not be blocked.');
        return {
          title: 'Goal blocked',
          output: `The goal is marked blocked. Tell the user exactly what input is needed.\n\n${summary}`,
          meta: { status: 'blocked' },
        };
      }
      throw new ToolError('bad_arguments', `Unknown goal action "${action}". Use status, complete, or blocked.`);
    },
  };
}
