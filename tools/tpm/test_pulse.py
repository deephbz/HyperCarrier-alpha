"""Consumer tests: skipped deltas, lost checkpoints, branch contamination and bad anchors."""
import tempfile
import unittest
from pathlib import Path
from pulse import Pulse, PulseError, selection


class PulseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pulse = Pulse(Path(self.tmp.name) / 'state')
        self.addCleanup(self.pulse.db.close)
        self.rows = [dict(sourceEntryId='a', text='Started the parser.', role='user', outcome='user', timestamp=None)]
        self.calls = []
        self.fail = False
        self.bad_anchor = False
        self.config = dict(catalog_command=['catalog'], rarebit_command=['rarebit'], assess_command=['assess'])

    def invoke(self, argv, payload=None):
        if argv[0] == 'catalog':
            return [dict(id='pi:test', harness='pi', role='solo', scratch=0, path='unused')]
        if argv[0] == 'rarebit':
            return dict(schemaVersion=1, selectorVersion='rarebit-selector-v1', session={'id': 'test'}, rarebitCount=len(self.rows), rarebits=self.rows)
        self.calls.append(payload)
        if self.fail:
            raise PulseError('model unavailable')
        return dict(summary='Reported parser progress.', claims=[dict(text='Parser work reported.', anchors=['wrong' if self.bad_anchor else self.rows[-1]['sourceEntryId']])])

    def tick(self):
        return self.pulse.tick(self.config, self.invoke)

    def test_restart_and_idle_do_not_call_model(self):
        self.assertEqual(self.tick()['updated'], 1)
        again = Pulse(Path(self.tmp.name) / 'state')
        self.addCleanup(again.db.close)
        self.assertEqual(again.tick(self.config, self.invoke)['unchanged'], 1)
        self.assertEqual(len(self.calls), 1)

    def test_append_sends_only_new_evidence_and_previous_state(self):
        self.tick()
        self.rows.append(dict(self.rows[0], sourceEntryId='b', text='Parser implemented.'))
        self.tick()
        self.assertEqual([m['sourceEntryId'] for m in self.calls[-1]['messages']], ['b'])
        self.assertIsNotNone(self.calls[-1]['previous'])

    def test_failure_retries_without_losing_delta(self):
        self.fail = True
        self.assertEqual(len(self.tick()['gaps']), 1)
        self.assertEqual(self.pulse.read()['assessments'], [])
        self.fail = False
        self.assertEqual(self.tick()['updated'], 1)
        self.assertEqual(len(self.calls[-1]['messages']), 1)

    def test_rewind_discards_old_assessment(self):
        self.tick()
        self.rows = [dict(self.rows[0], sourceEntryId='branch-b', text='Abandon parser work.')]
        self.tick()
        self.assertEqual(self.calls[-1]['mode'], 'rebuild')
        self.assertIsNone(self.calls[-1]['previous'])

    def test_mutated_entry_rebuilds_even_with_same_id(self):
        self.tick()
        self.rows[0]['text'] = 'Corrected request.'
        self.tick()
        self.assertEqual(self.calls[-1]['mode'], 'rebuild')

    def test_bad_anchor_does_not_advance(self):
        self.bad_anchor = True
        self.assertEqual(len(self.tick()['gaps']), 1)
        self.assertEqual(self.pulse.read()['assessments'], [])

    def test_budget_does_not_silently_truncate(self):
        self.config['max_input_chars'] = 1
        self.assertEqual(len(self.tick()['gaps']), 1)
        self.assertEqual(len(self.calls), 0)

    def test_known_secret_pattern_withheld_before_model(self):
        self.rows[0]['text'] = 'sk-' + 'z' * 24
        self.assertEqual(len(self.tick()['gaps']), 1)
        self.assertEqual(len(self.calls), 0)

    def test_failed_refresh_marks_existing_assessment_stale(self):
        self.tick()
        self.rows.append(dict(self.rows[0], sourceEntryId='b'))
        self.fail = True
        self.tick()
        self.assertEqual(self.pulse.read()['assessments'][0]['gap'], 'model unavailable')

    def test_empty_branch_clears_old_progress_without_model(self):
        self.tick()
        self.rows = []
        self.tick()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.pulse.read()['assessments'][0]['assessment']['claims'], [])

    def test_backfill_advances_whole_messages_without_skipping(self):
        self.rows.append(dict(self.rows[0], sourceEntryId='b', text='Second event.'))
        self.config['max_input_chars'] = 150
        def invoke(argv, payload=None):
            if argv[0] == 'assess':
                self.calls.append(payload)
                return dict(summary='Progress.', claims=[dict(text='Reported.', anchors=[payload['messages'][-1]['sourceEntryId']])])
            return self.invoke(argv, payload)
        partial = self.pulse.tick(self.config, invoke)
        self.assertEqual(partial['updated'], 1)
        self.assertEqual(partial['gaps'][0]['reason'], 'backfill incomplete; more selected evidence remains')
        self.assertEqual(self.pulse.read()['assessments'][0]['source']['pending_messages'], 1)
        self.assertEqual(self.pulse.tick(self.config, invoke)['updated'], 1)
        self.assertEqual([p['messages'][0]['sourceEntryId'] for p in self.calls], ['a', 'b'])
        self.assertEqual(self.pulse.read()['assessments'][0]['source']['pending_messages'], 0)

    def test_old_native_messages_do_not_become_current_from_file_touch(self):
        self.rows[0]['timestamp'] = '2020-01-01T00:00:00Z'
        self.config['active_days'] = 1
        self.assertEqual(self.tick()['excluded'], 1)
        self.assertEqual(self.calls, [])

    def test_synthesis_is_cached_and_qualified(self):
        self.config['synthesize_command'] = ['synth']
        calls = []
        def invoke(argv, payload=None):
            if argv[0] == 'synth':
                calls.append(payload)
                anchor = payload['evidence']['threads'][0]['assessment']['claims'][0]['anchors'][0]
                return dict(summary='Thread reports progress.', claims=[dict(text='Reported.', anchors=[anchor])])
            return self.invoke(argv, payload)
        self.assertEqual(self.pulse.tick(self.config, invoke)['synthesis'], 'updated')
        self.assertEqual(self.pulse.tick(self.config, invoke)['synthesis'], 'unchanged')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.pulse.read()['synthesis']['assessment']['claims'][0]['anchors'], ['pi:test#a'])

    def test_changed_context_invalidates_synthesis(self):
        context = Path(self.tmp.name) / 'charter.md'
        context.write_text('Example policy is accepted.')
        self.config.update(context_files=[str(context)], synthesize_command=['synth'])
        def invoke(argv, payload=None):
            if argv[0] == 'synth':
                return dict(summary='Example policy exists.', claims=[dict(text='Accepted policy.', anchors=[payload['evidence']['store_context'][0]['anchor']])])
            return self.invoke(argv, payload)
        self.pulse.tick(self.config, invoke)
        self.assertFalse(self.pulse.read()['synthesis']['stale'])
        context.write_text('Example policy is pending review.')
        self.assertTrue(self.pulse.read()['synthesis']['stale'])
        self.assertEqual(self.pulse.tick(self.config, invoke)['synthesis'], 'updated')

    def test_model_budget_retains_checkpoint(self):
        self.config['max_assessments'] = 0
        self.assertEqual(len(self.tick()['gaps']), 1)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.pulse.read()['assessments'], [])

    def test_overlap_does_not_start_commands(self):
        import fcntl
        with (self.pulse.directory / 'run.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.tick(), {'busy': True})
        self.assertEqual(self.calls, [])

    def test_unsupported_harness_is_a_gap_without_model_call(self):
        def invoke(argv, payload=None):
            if argv[0] == 'catalog':
                return [dict(id='example:test', harness='example', role='solo', path='unused')]
            return self.invoke(argv, payload)
        result = self.pulse.tick(self.config, invoke)
        self.assertEqual(result['gaps'], [{'id': 'example:test', 'reason': 'input adapter pending'}])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.pulse.read()['assessments'], [])

    def test_selector_change_fails_closed(self):
        with self.assertRaises(PulseError):
            selection(dict(schemaVersion=1, selectorVersion='future', session={'id': 'test'}, rarebitCount=0, rarebits=[]), 'test')

    def test_reject_wrong_session(self):
        with self.assertRaises(PulseError):
            selection(dict(schemaVersion=1, session={'id': 'other'}, rarebits=[]), 'test')


if __name__ == '__main__':
    unittest.main()
