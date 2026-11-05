import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from app import Store
from card_values import delivery_values, rating, rubles
from market_search import BrowserSearch, normalize_cards


class ValueTests(unittest.TestCase):
    def test_separate_ratings_and_unknowns(self):
        cards = normalize_cards('ozon', [dict(url='https://ozon.ru/product/1', title='Kiwi',
                               product_rating='4,9', seller_rating=None, price_text='19 990 ₽',
                               delivery_text='Доставка 3–5 дней. Доставка 300 ₽')])
        self.assertEqual(cards[0]['product_rating'], 4.9)
        self.assertIsNone(cards[0]['seller_rating'])
        self.assertEqual(cards[0]['price_minor'], 1999000)
        self.assertEqual(cards[0]['shipping_minor'], 30000)
        self.assertEqual(cards[0]['days_max'], 5)
        for value in ('98%', 'NaN', float('inf'), True, -1, 5.1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                rating(value)
        self.assertEqual(rating(0), 0)
        self.assertIsNone(rating(''))

    def test_unknown_currency_or_delivery_never_become_free_or_fast(self):
        for value in ('100 USD', '20 000', 'от 300 ₽', 'Цена 500 ₽ по подписке'):
            self.assertIsNone(rubles(value))
        self.assertEqual(delivery_values('Стоимость доставки неизвестна'), dict(days_min=None, days_max=None, shipping_minor=None))
        self.assertEqual(delivery_values('Доставка завтра бесплатно')['days_max'], 1)
        self.assertEqual(delivery_values('Доставка завтра бесплатно')['shipping_minor'], 0)
        self.assertEqual(delivery_values('Доставка 0 ₽. Через 2 дня')['shipping_minor'], 0)
        self.assertEqual(delivery_values('Доставка 10–12 ноября', date(2026, 11, 5))['days_max'], 7)
        self.assertIsNone(delivery_values('Доставка 40–2 дней')['days_max'])
        self.assertIsNone(delivery_values('Доставка 1000–200 дней')['days_max'])
        self.assertIsNone(delivery_values('Доставка 10 ноября 2027', date(2026, 11, 5))['days_max'])
        self.assertIsNone(delivery_values('Доставка 30 ноября–2 декабря', date(2026, 11, 5))['days_max'])


class RatingStoreTests(unittest.TestCase):
    def test_old_database_migrates_without_rewriting_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'old.sqlite3'
            with sqlite3.connect(path) as db:
                db.executescript('''
                    CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,demo INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE offers(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,market TEXT NOT NULL,url TEXT NOT NULL UNIQUE,seller TEXT NOT NULL);
                    CREATE TABLE observations(id INTEGER PRIMARY KEY,offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,at TEXT NOT NULL,price INTEGER NOT NULL,shipping INTEGER NOT NULL,days_min INTEGER NOT NULL,days_max INTEGER NOT NULL,city TEXT NOT NULL,terms TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual');
                    INSERT INTO products VALUES(1,'Kiwi',0);
                    INSERT INTO offers VALUES(1,1,'ozon','https://ozon.ru/product/123','Магазин');
                    INSERT INTO observations VALUES(1,1,'2026-11-04T12:00:00Z',100050,99,2,4,'Санкт-Петербург','Без подписки','manual');
                ''')
            store = Store(path)
            old = store.snapshot()['products'][0]['offers'][0]['history'][0]
            self.assertEqual(old['price'], 100050)
            self.assertEqual(old['at'], '2026-11-04T12:00:00Z')
            self.assertIsNone(old['product_rating'])
            body = dict(price='990.50', shipping=0, days_min=1, days_max=3,
                        city='Санкт-Петербург', product_rating=4.9, seller_rating=4.2)
            store.add_observation(1, body)
            history = Store(path).snapshot()['products'][0]['offers'][0]['history']
            self.assertEqual(len(history), 2)
            self.assertEqual(history[-1]['product_rating'], 4.9)
            self.assertEqual(history[-1]['seller_rating'], 4.2)
            with self.assertRaises(ValueError):
                store.add_observation(1, {**body, 'seller_rating': 98})
            self.assertEqual(len(Store(path).snapshot()['products'][0]['offers'][0]['history']), 2)


class ExtensionManagerTests(unittest.TestCase):
    def test_extension_requires_no_playwright_and_keeps_same_market_cards(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = BrowserSearch(Path(tmp) / 'profile')
            with patch.object(BrowserSearch, 'installed', return_value=False):
                job_id = manager.start('Kiwi', mode='extension')
            for suffix in ('123', '456'):
                manager.receive(job_id, {'market': 'ozon', 'extracted': {'cards': [dict(url=f'https://ozon.ru/product/{suffix}', title='Kiwi', price_text='100 ₽')]}})
            manager.receive(job_id, {'market': 'ozon', 'extracted': {'cards': [dict(url='https://ozon.ru/product/123', title='Kiwi', detail=True, price_text='90 ₽', product_rating=4.8)]}})
            manager.receive(job_id, {'market': 'ozon', 'extracted': {'cards': [dict(url='https://ozon.ru/product/123', title='Kiwi', price_text='100 ₽')]}})
            results = manager.snapshot(job_id)['results']
            self.assertEqual(len(results), 2)
            self.assertEqual(results[0]['price_minor'], 9000)
            self.assertEqual(results[0]['product_rating'], 4.8)
            manager.command(job_id, 'close')
            with self.assertRaises(ValueError):
                manager.receive(job_id, {'market': 'ozon', 'extracted': {'cards': []}})
            self.assertEqual(manager.snapshot(job_id)['status'], 'closed')
            self.assertEqual(len(manager.snapshot(job_id)['results']), 2)

    def test_invalid_or_old_job_cannot_receive_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = BrowserSearch(Path(tmp))
            job_id = manager.start('Kiwi', mode='extension')
            with self.assertRaises(LookupError):
                manager.receive('wrong', {'market': 'ozon', 'extracted': {'cards': []}})
            with self.assertRaises(ValueError):
                manager.receive(job_id, {'market': 'unknown', 'extracted': {'cards': []}})
            with self.assertRaises(ValueError):
                manager.receive(job_id, {'market': 'ozon', 'extracted': {'cards': 'not a list'}})
