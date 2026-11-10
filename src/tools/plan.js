import { ToolError } from './errors.js';

// The `plan` tool: the ending move of plan mode. It hands the finished,
// detailed plan back to the user, who can then choose to build it.

export function createPlanTool({ planManager }) {
  return {
    name: 'plan',
    group: 'plan',
    description: 'Submit a detailed, self-contained implementation plan for the user to review. Use this in plan mode once the plan is complete. Do not call it before you have enough answers.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The full plan as markdown. It must read as a detailed prompt the user can paste into build mode: goal, files, steps, edge cases, tests, done criteria.' },
        questionsAsked: { type: 'integer', description: 'How many clarifying questions you asked the user while planning.' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    async execute(args) {
      const plan = String(args?.plan || '').trim();
      if (!plan) throw new ToolError('bad_arguments', 'plan is required.');
      if (plan.length < 120) throw new ToolError('bad_arguments', 'The plan is too thin. Write a detailed, self-contained implementation prompt before submitting it.');
      if (!planManager?.submit) {
        throw new ToolError('plan_unavailable', 'No plan is open in this session. The user can still read the plan in your answer.');
      }
      await planManager.submit({ plan, questionsAsked: Number(args?.questionsAsked) || 0 });
      return {
        title: 'Plan submitted',
        output: 'The plan was handed to the user. Wait for them to choose build mode, then stop.',
      };
    },
  };
}
