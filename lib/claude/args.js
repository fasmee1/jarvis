'use strict';
// Build the argument array for the Claude Code CLI (verified against
// claude 2.1.301 — see PROGRESS.md, phase 0).

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function buildClaudeArgs(o) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--setting-sources', 'user,project,local',
  ];
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  const mode = PERMISSION_MODES.includes(o.permissionMode) ? o.permissionMode : 'default';
  args.push('--permission-mode', mode);
  if (o.permissionPromptTool) args.push('--permission-prompt-tool', o.permissionPromptTool);
  const mcp = (o.mcpConfigs || []).filter(Boolean);
  if (mcp.length) args.push('--mcp-config', ...mcp);
  if (o.settingsJson) args.push('--settings', o.settingsJson);
  for (const d of o.addDirs || []) if (d) args.push('--add-dir', d);
  if (o.model) args.push('--model', o.model);
  if (o.allowedTools && o.allowedTools.length) args.push('--allowedTools', o.allowedTools.join(','));
  if (o.disallowedTools && o.disallowedTools.length) args.push('--disallowedTools', o.disallowedTools.join(','));
  if (o.resume) args.push('--resume', o.resume);
  return args;
}

module.exports = { buildClaudeArgs, PERMISSION_MODES };
