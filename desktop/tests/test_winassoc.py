import os
import unittest

from cherrion_desktop import winassoc

# A scratch key instead of Software\Classes, so the real file associations are never touched.
ROOT = r'Software\CherrionTests'
CLASSES = ROOT + r'\Classes'


@unittest.skipUnless(os.name == 'nt', 'Windows registry')
class FileAssociationTest(unittest.TestCase):
    def tearDown(self) -> None:
        winassoc._delete_tree(ROOT)

    def test_register_and_unregister(self) -> None:
        exe = r'C:\Apps\Cherrion\Cherrion.exe'
        self.assertFalse(winassoc.is_registered(exe, CLASSES))
        winassoc.register(exe, CLASSES)
        self.assertTrue(winassoc.is_registered(exe, CLASSES))
        self.assertEqual(winassoc._read(CLASSES + r'\Cherrion.Vault\shell\open\command'), f'"{exe}" "%1"')
        self.assertEqual(winassoc._read(CLASSES + r'\Cherrion.Vault\DefaultIcon'), f'"{exe}",0')
        winassoc.unregister(CLASSES)
        self.assertFalse(winassoc.is_registered(exe, CLASSES))
        self.assertIsNone(winassoc._read(CLASSES + r'\.cherrion'))

    def test_follows_a_moved_exe_only_when_turned_on(self) -> None:
        self.assertFalse(winassoc.refresh(r'D:\New\Cherrion.exe', CLASSES))  # never registers on its own
        winassoc.register(r'C:\Old\Cherrion.exe', CLASSES)
        self.assertTrue(winassoc.refresh(r'D:\New\Cherrion.exe', CLASSES))
        self.assertTrue(winassoc.is_registered(r'D:\New\Cherrion.exe', CLASSES))
        self.assertFalse(winassoc.refresh(r'D:\New\Cherrion.exe', CLASSES))  # already current

    def test_leaves_another_apps_claim_alone(self) -> None:
        winassoc._write(CLASSES + r'\.cherrion', 'SomeOtherApp.File')
        winassoc.unregister(CLASSES)
        self.assertEqual(winassoc._read(CLASSES + r'\.cherrion'), 'SomeOtherApp.File')
        self.assertFalse(winassoc.refresh(r'C:\Cherrion.exe', CLASSES))


if __name__ == '__main__':
    unittest.main()
