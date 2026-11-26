import tempfile
import unittest
import urllib.request
from pathlib import Path

from cherrion_desktop.server import serve


class StaticServerTest(unittest.TestCase):
    def test_two_windows_never_share_a_port(self) -> None:
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            Path(a, 'index.html').write_text('first')
            Path(b, 'index.html').write_text('second')
            url_a, url_b = serve(Path(a)), serve(Path(b))
            self.assertNotEqual(url_a, url_b)
            # Each window gets its own files (a shared port would hand B the first app's page).
            self.assertEqual(urllib.request.urlopen(url_a).read(), b'first')
            self.assertEqual(urllib.request.urlopen(url_b).read(), b'second')

    def test_refuses_other_host_names(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            Path(root, 'index.html').write_text('app')
            url = serve(Path(root))
            req = urllib.request.Request(url, headers={'Host': 'attacker.example'})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req)
            self.assertEqual(ctx.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
