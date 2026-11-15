// Disposable drivers use process generations to observe owner death, including SIGKILL.
// This module never signals a PID. Production residents do not use this lifetime.
const { execFileSync } = require('node:child_process');
function processIdentity(pid) {
 if (!Number.isSafeInteger(pid) || pid <= 1) return null;
 try {
  const row = execFileSync('ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C' } }).trim();
  const [, state, started] = /^(\S+)\s+(.*)$/.exec(row) ?? [];
  if (!started || /^[ZXx]/.test(state) || (process.platform === 'darwin' && state.includes('E'))) return null;
  // ps start times have one-second resolution. This guards ordinary reuse, not same-second reuse.
  return JSON.stringify({ pid, started });
 } catch { return null; }
}
function ownerAlive(identity) {
 if (!identity) return false;
 try { return processIdentity(JSON.parse(identity).pid) === identity; } catch { return false; }
}
module.exports = { processIdentity, ownerAlive };
