import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function typedFixture(pi: ExtensionAPI) {
  const notice: string = 'Typed fixture loaded';
  pi.on('session_start', (_event, ctx) => ctx.ui.notify(notice, 'info'));
}
