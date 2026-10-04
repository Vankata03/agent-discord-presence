// Scripted model turns for mock-gemini.mjs. Each key matches the prompt; each
// step is one model response's parts.
const call = (name, args) => ({ functionCall: { name, args } });

export default {
  // Two tools in one response (a slow command beside a file read), then a write.
  'scenario-a': [
    [
      call('run_shell_command', { command: 'sleep 1.5; echo slow', description: 'slow' }),
      call('read_file', { file_path: 'README.md' }),
    ],
    [call('write_file', { file_path: 'hello.txt', content: 'hi\n' })],
  ],
  // A command that needs approval in default approval mode.
  'scenario-b': [
    [call('run_shell_command', { command: 'touch probe-approved.txt', description: 'probe' })],
  ],
};
