// Scripted model turns for mock-responses.mjs. Each key matches the prompt (or
// a subagent's task message); each step is one model response's output items.
const exec = (id, cmd, extra = {}) => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: id,
  name: 'exec_command',
  arguments: JSON.stringify({ cmd, yield_time_ms: 5000, ...extra }),
});
/** A `collaboration` namespace `spawn_agent` call. */
const spawn = (id, task) => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: id,
  name: 'spawn_agent',
  namespace: 'collaboration',
  arguments: JSON.stringify({
    task_name: task.replace('-', '_'),
    message: task,
    fork_turns: 'none',
  }),
});
/** An `apply_patch` custom tool call that adds one file. */
const patch = (id, file) => ({
  type: 'custom_tool_call',
  id: `ctc_${id}`,
  call_id: id,
  name: 'apply_patch',
  input: `*** Begin Patch\n*** Add File: ${file}\n+hi\n*** End Patch\n`,
});

export default {
  // Two tools finishing out of order, a patch, then two overlapping subagents.
  'scenario-a': [
    [exec('call_slow', 'sleep 1.5; echo slow'), exec('call_fast', 'echo fast')],
    [patch('call_patch', 'hello.txt')],
    [spawn('call_sub1', 'subtask-one'), spawn('call_sub2', 'subtask-two')],
  ],
  'subtask-one': [[exec('call_sub_exec1', 'sleep 1; echo one')]],
  'subtask-two': [[exec('call_sub_exec2', 'echo two')]],
  // An escalated command (PermissionRequest) beside a plain one.
  'scenario-b': [
    [
      exec('call_esc', 'touch /tmp/vdp-probe-escalated', {
        sandbox_permissions: 'require_escalated',
        justification: 'probe',
      }),
      exec('call_plain', 'echo plain'),
    ],
    [patch('call_patch2', '/tmp/outside-vdp.txt')],
  ],
};
