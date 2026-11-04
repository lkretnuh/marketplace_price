import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import Store
from market_search import BrowserSearch, SearchBusy, normalize_cards


class NormalizeTests(unittest.TestCase):
    def test_keeps_multiple_cards_without_inventing_unknown_values(self):
        raw = [{'url': 'https://www.ozon.ru/product/kiwi-123/#tracking', 'title': 'Kiwi Ears Orchestra Lite'},
               {'url': 'https://www.ozon.ru/product/kiwi-456/', 'title': 'Kiwi Ears Orchestra Lite', 'price_text': '19 990 ₽'},
               {'url': 'https://www.ozon.ru/product/kiwi-123/#another', 'title': 'duplicate'}]
        cards = normalize_cards('ozon', raw)
        self.assertEqual(len(cards), 2)
        self.assertIsNone(cards[0]['price_text'])
        self.assertIsNone(cards[0]['delivery_text'])
        self.assertIsNone(cards[0]['seller'])
        self.assertEqual(cards[1]['price_text'], '19 990 ₽')

    def test_untrusted_links_are_not_returned(self):
        raw = [{'url': url, 'title': 'Kiwi'} for url in ['javascript:alert(1)',
               'https://ozon.ru.evil.test/product/1', 'https://user:secret@ozon.ru/product/2',
               'http://www.ozon.ru/product/3', 'https://wildberries.ru/catalog/123/detail.aspx',
               'https://ozon.ru:1234/product/4', 'https://[malformed']]
        self.assertEqual(normalize_cards('ozon', raw), [])


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manager = BrowserSearch(Path(self.tmp.name) / 'profile')

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_module_has_actionable_error(self):
        with patch.object(BrowserSearch, 'installed', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'setup-search-windows'):
                self.manager.start('Kiwi')

    def test_status_snapshot_and_single_browser_session(self):
        with patch.object(BrowserSearch, 'installed', return_value=True), patch.object(BrowserSearch, '_run'):
            job_id = self.manager.start('Kiwi Ears Orchestra Lite')
            snapshot = self.manager.snapshot(job_id)
            snapshot['query'] = 'changed'
            self.assertEqual(self.manager.snapshot()['query'], 'Kiwi Ears Orchestra Lite')
            with self.assertRaises(SearchBusy):
                self.manager.start('Another product')
            with self.assertRaises(LookupError):
                self.manager.snapshot('wrong-id')
            self.manager.command(job_id, 'collect')
            self.assertEqual(self.manager.commands.get_nowait(), 'collect')

    def test_blocked_unreadable_and_empty_are_distinct(self):
        class Page:
            def __init__(self, value): self.value = value
            def is_closed(self): return False
            def evaluate(self, script, market): return self.value
        self.manager.job = {'id': 'test'}
        self.manager._collect({'ozon': Page({'cards': [], 'blocked': True}),
                               'wb': Page({'cards': [], 'empty': True}),
                               'yandex': Page({'cards': []})}, {'ali': 'Timeout'})
        job = self.manager.snapshot()
        self.assertEqual(job['markets']['ozon']['status'], 'attention')
        self.assertEqual(job['markets']['wb']['status'], 'empty')
        self.assertEqual(job['markets']['yandex']['status'], 'unreadable')
        self.assertEqual(job['markets']['ali']['status'], 'error')
        self.assertEqual(job['results'], [])

    def test_product_repeated_query_reuses_existing_group(self):
        store = Store(Path(self.tmp.name) / 'prices.sqlite3')
        first = store.create_product({'name': 'Kiwi Ears Orchestra Lite'})
        again = store.create_product({'name': '  KIWI  Ears Orchestra Lite  '})
        self.assertEqual(first, again)
        self.assertEqual(len(store.snapshot()['products']), 1)
