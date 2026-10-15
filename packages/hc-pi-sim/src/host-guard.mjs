// Fail closed for unmodeled external effects. Reads may load source/dependencies outside HOME.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

export function installHostGuard(root, violations) {
  const restores = [], ownedDescriptors = new Set();
  const rootReal = fs.realpathSync(root), originalRealpath = fs.realpathSync;
  const deny = operation => {
    const message = `unmodeled host effect rejected: ${operation}`;
    violations.push(message); throw new Error(message);
  };
  const replace = (object, key, fn) => {
    const old = object[key]; if (typeof old !== 'function') return;
    object[key] = fn(old); restores.push(() => { object[key] = old; });
  };
  const inside = path => {
    if (typeof path === 'number') return ownedDescriptors.has(path);
    let candidate = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    const remainder = [];
    while (true) {
      try { candidate = resolve(originalRealpath(candidate), ...remainder.reverse()); break; }
      catch (error) {
        if (error.code !== 'ENOENT') return false;
        const parent = dirname(candidate);
        if (parent === candidate) return false;
        remainder.push(candidate.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
        candidate = parent;
      }
    }
    const rel = relative(rootReal, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const guarded = (name, positions) => original => function(...args) {
    for (const index of positions) if (!inside(args[index])) deny(`fs.${name} outside isolated root`);
    return Reflect.apply(original, this, args);
  };
  const paths = { writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0], rename: [0, 1], copyFile: [1], cp: [1], truncate: [0], chmod: [0], chown: [0], utimes: [0], link: [0, 1], createWriteStream: [0] };
  for (const [name, positions] of Object.entries(paths)) {
    replace(fs, name, guarded(name, positions));
    replace(fs, `${name}Sync`, guarded(`${name}Sync`, positions));
    replace(fsp, name, guarded(name, positions));
  }
  for (const object of [fs, fsp]) for (const name of ['symlink', 'symlinkSync']) replace(object, name, () => () => deny('symlink creation'));
  const openGuard = original => function(path, flags, ...args) {
    const writes = typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : !['r', 'rs', 'sr'].includes(flags ?? 'r');
    if (writes && !inside(path)) deny('fs.open outside isolated root');
    const owned = inside(path);
    const callback = args.at(-1);
    if (typeof callback === 'function') args[args.length - 1] = (error, fd) => {
      if (!error && owned) ownedDescriptors.add(fd);
      callback(error, fd);
    };
    const result = Reflect.apply(original, this, [path, flags, ...args]);
    if (typeof result === 'number' && owned) ownedDescriptors.add(result);
    if (result?.then) return result.then(handle => {
      if (owned) ownedDescriptors.add(handle.fd);
      const close = handle.close.bind(handle), fd = handle.fd;
      handle.close = (...closeArgs) => { ownedDescriptors.delete(fd); return close(...closeArgs); };
      return handle;
    });
    return result;
  };
  replace(fs, 'open', openGuard); replace(fs, 'openSync', openGuard); replace(fsp, 'open', openGuard);
  for (const name of ['close', 'closeSync']) replace(fs, name, original => function(fd, ...args) {
    ownedDescriptors.delete(fd);
    return Reflect.apply(original, this, [fd, ...args]);
  });
  for (const name of ['write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes']) {
    replace(fs, name, guarded(name, [0])); replace(fs, `${name}Sync`, guarded(`${name}Sync`, [0]));
  }
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) replace(childProcess, name, () => () => deny(`child_process.${name}`));
  replace(net.Socket.prototype, 'connect', () => () => deny('socket.connect'));
  replace(net.Server.prototype, 'listen', () => () => deny('server.listen'));
  replace(dgram, 'createSocket', () => () => deny('dgram.createSocket'));
  syncBuiltinESMExports();
  return () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); };
}
