"""Synthetic checks for installed-path isolation and explicit cycle refresh."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pulse_cycle
import validate


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def page(self, name, identity='example'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'---\nid: {identity}\ntype: project\nstatus: review-pending\n---\n')
        return path

    def test_validator_cli_uses_temp_root_from_other_cwd(self):
        self.page('README.md')
        script = Path(validate.__file__).resolve()
        run = subprocess.run([sys.executable, str(script), '--root', str(self.root)],
                             cwd='/', capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertIn('checked 1 pages', run.stdout)
        self.page('projects/example.md')
        run = subprocess.run([sys.executable, str(script), '--root', str(self.root)],
                             cwd='/', capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertIn('duplicate id', run.stdout)

    def test_validator_rejects_missing_root_argument(self):
        run = subprocess.run([sys.executable, validate.__file__], capture_output=True)
        self.assertEqual(run.returncode, 2)

    def test_validator_rejects_empty_store_and_detects_links_and_secrets(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(validate.validate(self.root), 1)
        page = self.page('README.md')
        with page.open('a') as handle:
            handle.write('[missing](absent.md)\n' + 'sk-' + 'z' * 24 + '\n')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(validate.validate(self.root), 1)
        self.assertIn('broken link', output.getvalue())
        self.assertIn('possible secret', output.getvalue())
        self.assertNotIn('z' * 24, output.getvalue())

    def cycle(self, config, refresh_code=0):
        state = self.root / 'state'
        config_path = self.root / 'config.json'
        config_path.write_text(json.dumps(config))
        argv = ['pulse_cycle', '--state', str(state), '--config', str(config_path)]
        with patch.object(sys, 'argv', argv), \
                patch.object(pulse_cycle.subprocess, 'run') as refresh, \
                patch.object(pulse_cycle.Pulse, 'tick', return_value={'gaps': []}) as tick, \
                contextlib.redirect_stdout(io.StringIO()):
            refresh.return_value.returncode = refresh_code
            code = pulse_cycle.main()
        return code, refresh, tick, json.loads((state / 'last-cycle.json').read_text())

    def test_cycle_runs_configured_refresh_without_shell(self):
        code, refresh, tick, health = self.cycle({'refresh_command': ['example-tool', 'refresh']})
        self.assertEqual(code, 0)
        refresh.assert_called_once_with(['example-tool', 'refresh'], capture_output=True, timeout=120)
        tick.assert_called_once()
        self.assertIn('cycle', health)

    def test_cycle_can_explicitly_omit_refresh(self):
        code, refresh, tick, _ = self.cycle({})
        self.assertEqual(code, 0)
        refresh.assert_not_called()
        tick.assert_called_once()

    def test_null_refresh_does_not_start_a_command(self):
        code, refresh, tick, _ = self.cycle({'refresh_command': None})
        self.assertEqual(code, 0)
        refresh.assert_not_called()
        tick.assert_called_once()

    def test_failed_refresh_prevents_tick_and_withholds_diagnostics(self):
        code, _, tick, health = self.cycle({'refresh_command': ['example-tool']}, 1)
        self.assertEqual(code, 1)
        tick.assert_not_called()
        self.assertEqual(health['error'], 'cycle failed; existing state retained')


if __name__ == '__main__':
    unittest.main()
