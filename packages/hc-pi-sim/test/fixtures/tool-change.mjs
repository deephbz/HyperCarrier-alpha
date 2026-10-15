// Synthetic extension: real registration, session_start and tool activation paths.
export function toolChangeExtension(pi) {
  for (const name of ['anchor', 'optional']) pi.registerTool({
    name, label: name, description: `Synthetic ${name} operation`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: {} }),
  });
  pi.on('session_start', () => pi.setActiveTools(['anchor']));
  pi.registerCommand('activate', { description: 'Activate the optional fixture tool', handler: async () => pi.setActiveTools(['anchor', 'optional']) });
  pi.registerCommand('deactivate', { description: 'Deactivate the optional fixture tool', handler: async () => pi.setActiveTools(['anchor']) });
}
export const safeCompat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
// Two independent compat mutants: native tool changes require both capabilities.
export const mutants = [
  { name: 'disable-native-tool-changes', compat: { ...safeCompat, supportsMidConvoToolChanges: false } },
  { name: 'disable-mid-conversation-system', compat: { ...safeCompat, supportsMidConvoSystemMessages: false } },
];
