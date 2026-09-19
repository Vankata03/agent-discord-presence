/** Claude Code event name and the normalized event argument passed to VDP. */
export const CLAUDE_CODE_HOOK_EVENTS: ReadonlyArray<{ name: string; arg: string }> = [
  { name: 'SessionStart', arg: 'session-start' },
  { name: 'UserPromptSubmit', arg: 'user-prompt-submit' },
  { name: 'PreToolUse', arg: 'pre-tool-use' },
  { name: 'Notification', arg: 'notification' },
  { name: 'Stop', arg: 'stop' },
  { name: 'SessionEnd', arg: 'session-end' },
];
