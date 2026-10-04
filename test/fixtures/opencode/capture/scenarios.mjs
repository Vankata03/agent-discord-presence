// Scripted model turns for mock-openai.mjs. Each key matches a user prompt (or
// a subagent task prompt); each step is one model response: optional text, and
// tool calls OpenCode runs in parallel. WORK is the capture work directory,
// because OpenCode's file tools take absolute paths.
const WORK = process.env.WORK ?? '/tmp/work';
const call = (name, args) => ({ name, args });

export default {
  // A slow command beside a file read in one response, then a write.
  'scenario-tools': [
    {
      calls: [
        call('bash', { command: 'sleep 1.5; echo slow', description: 'Slow echo' }),
        call('read', { filePath: `${WORK}/README.md` }),
      ],
    },
    { calls: [call('write', { filePath: `${WORK}/hello.txt`, content: 'hi\n' })] },
    { text: 'done scenario-tools' },
  ],
  // Two commands that need approval (bash is `ask` in the capture config):
  // the first is approved once, the second rejected.
  'scenario-permission': [
    { calls: [call('bash', { command: 'touch approved.txt', description: 'Touch approved' })] },
    { calls: [call('bash', { command: 'touch rejected.txt', description: 'Touch rejected' })] },
    { text: 'done scenario-permission' },
  ],
  // A subagent whose own tool runs long enough to reload the plugin under it.
  'scenario-subagent': [
    {
      calls: [
        call('task', {
          description: 'Probe child',
          prompt: 'subtask-child: run the slow command',
          subagent_type: 'general',
        }),
      ],
    },
    { text: 'done scenario-subagent' },
  ],
  'subtask-child': [
    { calls: [call('bash', { command: 'sleep 4; echo child', description: 'Child sleep' })] },
    { text: 'done subtask-child' },
  ],
  // A long command, so a signal or quit lands mid-turn.
  'scenario-long': [
    { calls: [call('bash', { command: 'sleep 20; echo late', description: 'Long sleep' })] },
    { text: 'done scenario-long' },
  ],
  // A plain streamed answer, slow enough to see repeated updates.
  'scenario-text': [{ text: 'one two three four five six seven eight', delayMs: 150 }],
};
