// The `ask` tool: multiple-choice questions with an "other" option, asked
// asynchronously. It opens the question in the TUI, returns immediately, and
// the agent keeps doing safe preparation while the user reads. The answer
// arrives as the `ask_status` tool result (or a timeout, after 5 minutes).

export const ASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OPTIONS = 8;

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function buildAskQuestions(rawQuestions) {
  const rawList = Array.isArray(rawQuestions) ? rawQuestions : [];
  const questions = [];
  const seenIds = new Set();
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const question = clean(entry.question);
    if (!question) continue;
    const baseId = String(entry.id || question).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `q${questions.length + 1}`;
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 38)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);
    const options = [];
    const seenLabels = new Set();
    for (const option of (Array.isArray(entry.options) ? entry.options : []).slice(0, MAX_OPTIONS)) {
      if (!option || typeof option !== 'object') continue;
      const label = clean(option.label);
      if (!label || seenLabels.has(label.toLowerCase())) continue;
      seenLabels.add(label.toLowerCase());
      const idClean = String(option.id || '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || `opt-${options.length + 1}`;
      let optionId = idClean;
      let n = 2;
      const existing = new Set(options.map((item) => item.id));
      while (existing.has(optionId)) {
        optionId = `${idClean.slice(0, 38)}-${n}`;
        n += 1;
      }
      options.push({ id: optionId, label, description: clean(option.description) });
    }
    questions.push({ id, question, options, multiSelect: Boolean(entry.multiSelect) });
  }
  return questions;
}

export function createAskTool({ askManager }) {
  return {
    name: 'ask',
    group: 'ask',
    description: [
      'Ask the user one or more multiple-choice questions with an "other" option.',
      'This opens the question UI in their terminal immediately and returns right away.',
      'While the question is open, keep doing safe, reversible preparation only:',
      'read files, search, run tests, draft both alternatives — do NOT edit, write,',
      'delete, commit, push, or make any irreversible change until the answer arrives.',
      'Call ask_status with the returned question_id to collect the answer, then',
      'proceed. If the question expires after 5 minutes, ask_status tells you to',
      'cancel the task and clean up; do that, then stop your turn.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask. Each has 2-8 options; an "other" free-text option is added automatically.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id for the question (letters, digits, dashes, underscores).' },
              question: { type: 'string', description: 'The question to show the user.' },
              options: {
                type: 'array',
                description: 'Choices for the user.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable id for the option.' },
                    label: { type: 'string', description: 'Short label shown in the UI.' },
                    description: { type: 'string', description: 'What happens when it is picked. Shown under the label.' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow picking several options. Defaults to false.' },
            },
            required: ['question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const questions = buildAskQuestions(args.questions);
      if (!questions.length) {
        return { title: 'ask', output: 'No questions to ask; do not call ask with an empty list.' };
      }
      const opened = await askManager.ask({ questions, timeoutMs: ASK_TIMEOUT_MS });
      if (!opened?.questionId) {
        return { title: 'ask', output: `Could not open the question UI: ${opened?.message || 'no presenter available'}. Proceed without waiting for an answer.` };
      }
      return {
        title: `Asked: ${questions[0].question}`,
        output: [
          `Question ${opened.questionId} is open in the terminal. The user has 5 minutes.`,
          'Keep working on safe, reversible preparation in the meantime (read, search, plan, dry-runs).',
          'Call ask_status with this question_id to check for the answer.',
          'Do not edit, write, delete, commit, or make any irreversible change until the answer arrives.',
        ].join('\n'),
        meta: { questionId: opened.questionId },
      };
    },
  };
}

export function createAskStatusTool({ askManager }) {
  return {
    name: 'ask_status',
    group: 'ask',
    description: [
      'Check whether a question opened with the ask tool has been answered.',
      'Call after a safe prep step, or whenever you need the answer to proceed.',
      'When answered, it returns the user\'s selection. When the question times',
      'out (5 minutes), it tells you to cancel the task and clean up.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        question_id: { type: 'string', description: 'The question_id returned by ask.' },
      },
      required: ['question_id'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const id = String(args.question_id || '').trim();
      const state = askManager.status(id);
      if (!state) {
        return { title: 'ask_status', output: 'Unknown question id; there is nothing to check.' };
      }
      if (state.answered) {
        const lines = ['Answer received:'];
        for (const answer of state.results) {
          let value = answer.other || answer.text || '';
          if (!value && Array.isArray(answer.selectedLabels) && answer.selectedLabels.length) value = answer.selectedLabels.join(', ');
          if (!value && Array.isArray(answer.selected) && answer.selected.length) value = answer.selected.join(', ');
          lines.push(`- ${answer.question}: ${value || '(no selection)'}`);
        }
        lines.push('Proceed with the task using this answer.');
        return { title: 'ask_status', output: lines.join('\n') };
      }
      if (state.timedOut) {
        return {
          title: 'ask_status',
          output: `The question timed out after 5 minutes with no answer. Cancel the task now: undo any partial work, remove temporary files you created for this task, restore anything you changed that was waiting on the answer, and stop. Do not keep going without an answer. The question is still open in the UI; a late answer will arrive as a local event, after which you may start a fresh turn.`,
        };
      }
      const remaining = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
      return {
        title: 'ask_status',
        output: `Still waiting for the user (${remaining} seconds left). Keep doing safe, reversible preparation in the meantime.`,
      };
    },
  };
}
