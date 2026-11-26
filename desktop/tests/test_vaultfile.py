import sqlite3
import tempfile
import unittest
from pathlib import Path

from cherrion_desktop.remote import RemoteError, normalize_base_url, post
from cherrion_desktop.vaultfile import VaultFile, VaultFileError

HEADER = {'v': 1, 'vaultId': 'vault-1', 'kdf': {'alg': 'argon2id13'}, 'updatedAt': 1}


def env(id_: str, updated_at: int, deleted: bool = False) -> dict:
    return {'id': id_, 'updatedAt': updated_at, 'deleted': deleted, 'v': 1, 'nonce': 'bm9uY2U=', 'ct': f'ct-{updated_at}'}


class VaultFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / 'notes.cherrion'

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_create_read_and_reopen(self) -> None:
        vault = VaultFile.create(self.path, HEADER, [env('a', 1)], {'sync_url': 'https://x.test', 'sync_username': 'al', 'sync_since': 5})
        vault.close()
        vault = VaultFile.open(self.path)
        data = vault.read()
        vault.close()
        self.assertEqual(data['header'], HEADER)
        self.assertEqual([n['id'] for n in data['notes']], ['a'])
        self.assertEqual(data['dirty'], [])
        self.assertEqual(data['sync'], {'url': 'https://x.test', 'username': 'al', 'since': 5})

    def test_is_a_single_file_at_rest(self) -> None:
        vault = VaultFile.create(self.path, HEADER)
        vault.save([{'envelope': env('a', 2), 'dirty': True}])
        vault.close()
        self.assertEqual(sorted(p.name for p in Path(self.dir.name).iterdir()), ['notes.cherrion'])

    def test_last_write_wins_and_dirty_flags(self) -> None:
        vault = VaultFile.create(self.path, HEADER)
        vault.save([{'envelope': env('a', 5), 'dirty': True}])
        vault.save([{'envelope': env('a', 3), 'dirty': False}])  # older copy is ignored
        data = vault.read()
        self.assertEqual(data['notes'][0]['ct'], 'ct-5')
        self.assertEqual(data['dirty'], ['a'])
        vault.mark_clean([['a', 4]])  # a different version stays dirty
        self.assertEqual(vault.read()['dirty'], ['a'])
        vault.mark_clean([['a', 5]])
        self.assertEqual(vault.read()['dirty'], [])
        vault.close()

    def test_header_and_sync_settings(self) -> None:
        vault = VaultFile.create(self.path, HEADER)
        self.assertIsNone(vault.read()['sync'])
        vault.save(header={**HEADER, 'updatedAt': 2}, meta={'sync_url': 'https://x.test', 'sync_username': 'al', 'sync_since': 9})
        data = vault.read()
        self.assertEqual(data['header']['updatedAt'], 2)
        self.assertEqual(data['sync']['since'], 9)
        vault.save(meta={'sync_url': None, 'sync_username': None, 'sync_since': None})
        self.assertIsNone(vault.read()['sync'])
        with self.assertRaises(VaultFileError):
            vault.save(meta={'header': 'x'})
        vault.close()

    def test_refuses_plaintext_and_bad_input(self) -> None:
        vault = VaultFile.create(self.path, HEADER)
        with self.assertRaises(VaultFileError):
            vault.save([{'envelope': {'id': 'a', 'updatedAt': 1, 'deleted': False, 'title': 'secret'}}])
        with self.assertRaises(VaultFileError):
            vault.save([{'envelope': {**env('a', 1), 'updatedAt': True}}])
        vault.close()

    def test_second_window_cannot_open_the_same_file(self) -> None:
        vault = VaultFile.create(self.path, HEADER)
        with self.assertRaisesRegex(VaultFileError, 'already open'):
            VaultFile.open(self.path)
        vault.close()
        VaultFile.open(self.path).close()

    def test_will_not_overwrite_and_rejects_other_files(self) -> None:
        VaultFile.create(self.path, HEADER).close()
        with self.assertRaisesRegex(VaultFileError, 'already exists'):
            VaultFile.create(self.path, HEADER)
        text = Path(self.dir.name) / 'notes.txt'
        text.write_text('hello' * 100)
        with self.assertRaisesRegex(VaultFileError, 'not a Cherrion vault'):
            VaultFile.open(text)
        other = Path(self.dir.name) / 'other.db'
        sqlite3.connect(other).execute('create table t (x)').connection.close()
        with self.assertRaisesRegex(VaultFileError, 'not a Cherrion vault'):
            VaultFile.open(other)
        with self.assertRaisesRegex(VaultFileError, 'not found'):
            VaultFile.open(Path(self.dir.name) / 'missing.cherrion')
        self.assertFalse((Path(self.dir.name) / 'missing.cherrion').exists())


class RemoteTest(unittest.TestCase):
    def test_normalizes_server_addresses(self) -> None:
        self.assertEqual(normalize_base_url('cherrion-note.vercel.app/'), 'https://cherrion-note.vercel.app')
        self.assertEqual(normalize_base_url(' HTTPS://Example.com/sub/ '), 'https://example.com/sub')
        self.assertEqual(normalize_base_url('http://localhost:5173'), 'http://localhost:5173')
        for bad in ('', 'http://example.com', 'ftp://example.com', 'https://user:pw@example.com', 'https://'):
            with self.assertRaises(RemoteError, msg=bad):
                normalize_base_url(bad)

    def test_only_known_endpoints(self) -> None:
        with self.assertRaises(RemoteError):
            post('https://example.com', '../admin', '{}')

    def test_unreachable_server_is_status_zero_with_a_reason(self) -> None:
        res = post('http://127.0.0.1:9', 'status', '{}')
        self.assertEqual(res['status'], 0)
        self.assertIn('Cannot reach 127.0.0.1:9', res['data']['error'])

    def test_unknown_host_says_why(self) -> None:
        res = post('https://cherrion-test.invalid', 'status', '{}')
        self.assertEqual(res['status'], 0)
        self.assertIn('could not be looked up', res['data']['error'])


if __name__ == '__main__':
    unittest.main()
