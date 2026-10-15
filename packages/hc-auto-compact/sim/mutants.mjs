// Test-only mutations restore the former conditional active-tool declarations.
// Commands still execute the real controller. No controller reducer is replaced.
function conditionalTool(pi, name, activate, deactivate) {
  const remove = () => pi.setActiveTools(pi.getActiveTools().filter(tool => tool !== name));
  const add = () => { if (!pi.getActiveTools().includes(name)) pi.setActiveTools([...pi.getActiveTools(), name]); };
  return {
    api: new Proxy(pi, { get(target, key) {
      if (key !== 'registerCommand') return target[key];
      return (commandName, command) => target.registerCommand(commandName, { ...command,
        async handler(args, ctx) {
          if (activate(args)) add();
          const result = await command.handler(args, ctx);
          if (deactivate(args)) remove();
          return result;
        } });
    } }),
    after() {
      pi.on('session_start', remove);
      pi.on('before_agent_start', event => { if (event.prompt === 'After transition') remove(); });
    },
  };
}
export const mutants = [
  { name: 'conditional-ready', writer: 'ready', install: pi => conditionalTool(pi, 'auto_compact_ready', args => args === 'run', () => false) },
  { name: 'conditional-planner', writer: 'planner', install: pi => conditionalTool(pi, 'compaction_plan', args => args === 'method summary', args => args === 'method native') },
];
