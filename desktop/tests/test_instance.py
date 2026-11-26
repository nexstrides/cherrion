import json
import tempfile
import threading
import unittest
from pathlib import Path

from cherrion_desktop import instance
from cherrion_desktop.server import serve


class SingleInstanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / 'index.html').write_text('app')
        self.calls: list[str | None] = []
        self.called = threading.Event()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def on_activate(self, file: str | None) -> None:
        self.calls.append(file)
        self.called.set()

    def test_a_second_start_activates_the_running_one(self) -> None:
        token = instance.new_token()
        url = serve(self.home, on_activate=self.on_activate, activate_token=token)
        instance.register(self.home, url, token)
        self.assertTrue(instance.activate_existing(self.home, r'C:\notes\work.cherrion'))
        self.assertTrue(self.called.wait(3))
        self.assertEqual(self.calls, [r'C:\notes\work.cherrion'])

    def test_wrong_token_or_stale_file_starts_normally(self) -> None:
        url = serve(self.home, on_activate=self.on_activate, activate_token=instance.new_token())
        instance.register(self.home, url, 'not-the-token')
        self.assertFalse(instance.activate_existing(self.home, None))
        (self.home / instance.FILE).write_text(json.dumps({'port': 9, 'token': 'x'}))
        self.assertFalse(instance.activate_existing(self.home, None))
        (self.home / instance.FILE).unlink()
        self.assertFalse(instance.activate_existing(self.home, None))
        self.assertEqual(self.calls, [])

    def test_unregister_only_removes_its_own_file(self) -> None:
        instance.register(self.home, 'http://127.0.0.1:47219/', 'mine')
        instance.unregister(self.home, 'someone else')
        self.assertTrue((self.home / instance.FILE).exists())
        instance.unregister(self.home, 'mine')
        self.assertFalse((self.home / instance.FILE).exists())


if __name__ == '__main__':
    unittest.main()
