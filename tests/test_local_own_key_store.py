import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.local_own_key_store import LocalOwnKeyStore
from backend.apimart_image_provider import ImageTaskError


class LocalOwnKeyStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = patch.object(LocalOwnKeyStore, 'database', Path(self.directory.name)/'jobs.sqlite3')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = LocalOwnKeyStore()
        self.body = {'payload': {'n': 4}, 'references': ['reference']}

    def begin(self, owner='owner', mode='own_key'):
        return self.store.begin(owner, None, 'request', mode, 'gpt-image-2.6-flare', self.body, 'not persisted')

    def test_platform_is_rejected_and_own_key_never_creates_credit_records(self):
        with self.assertRaises(ImageTaskError):
            self.begin(mode='platform')
        row = self.begin()['job']
        self.assertEqual(row['unit_credit_cost'], 0)
        with self.store.transaction() as db:
            self.assertEqual(db.execute("select name from sqlite_master where type='table'").fetchall(), [('jobs',)])
        self.assertNotIn(b'not persisted', Path(self.store.database).read_bytes())

    def test_duplicate_unknown_cannot_authorize_another_paid_post(self):
        self.begin()
        self.assertTrue(self.store.apply('owner','request','sending')['send'])
        self.store.apply('owner','request','unknown',p_error='IMAGE_SUBMISSION_UNKNOWN')
        self.assertTrue(self.begin()['existing'])
        self.assertFalse(self.store.apply('owner','request','sending')['send'])
        self.assertEqual(self.store.jobs('owner')[0]['status'],'submission_unknown')

    def test_result_recovery_claim_race_and_owner_isolation(self):
        self.begin()
        self.store.apply('owner','request','sending')
        self.store.apply('owner','request','received',p_urls=['https://result.example.invalid/one'])
        self.assertEqual(self.store.jobs('someone-else'), [])
        with self.assertRaises(ImageTaskError):
            self.store.apply('someone-else','request','claim',p_token='first')
        self.assertTrue(self.store.apply('owner','request','claim',p_token='first')['claimed'])
        self.assertFalse(self.store.apply('owner','request','claim',p_token='second')['claimed'])
        self.store.apply('owner','request','retry',p_token='first')
        self.assertTrue(self.store.jobs('owner')[0]['provider_result_urls'])
        self.store.apply('owner','request','claim',p_token='second')
        row=self.store.apply('owner','request','completed',p_token='second',p_images=['one.gif'])['job']
        self.assertEqual(row['status'],'completed')
        self.assertEqual(row['provider_result_urls'],[])
        self.assertEqual(row['unit_credit_cost'],0)
