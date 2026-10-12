#!/usr/bin/env python3
"""One scheduled Pulse cycle: refresh catalog, tick, save bounded run health.

The trigger owns timing. This runner neither writes TPM pages nor posts views.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from pulse import Pulse, PulseError, encoded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    state = Path(args.state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = {'at': dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        pulse = Pulse(state)
        try:
            config = json.loads(Path(args.config).read_text())
            refresh = config.get('refresh_command')
            if refresh is not None:
                if (not isinstance(refresh, list) or not refresh or
                        not all(isinstance(arg, str) for arg in refresh)):
                    raise PulseError('refresh command must be a nonempty argv array')
                run = subprocess.run(refresh, capture_output=True, timeout=120)
                if run.returncode:
                    raise PulseError('catalog refresh failed')
            result['cycle'] = pulse.tick(config)
        finally:
            pulse.db.close()
    except (PulseError, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        result['error'] = 'cycle failed; existing state retained'
    if state.is_symlink() or state.stat().st_mode & 0o077:
        print('Pulse cycle failed; state directory must be owner-only.', file=sys.stderr)
        return 1
    if (state / 'last-cycle.json').is_symlink():
        print('Pulse cycle failed; health file must not be a symlink.', file=sys.stderr)
        return 1
    with tempfile.NamedTemporaryFile(mode='w', dir=state, delete=False) as temporary:
        temporary.write(encoded(result) + '\n')
    Path(temporary.name).replace(state / 'last-cycle.json')
    print(encoded(result))
    return int('error' in result or bool(result.get('cycle', {}).get('gaps')))


if __name__ == '__main__':
    sys.exit(main())
