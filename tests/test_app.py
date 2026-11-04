import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

from app import Handler, Store, ThreadingHTTPServer, market_url


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'test.sqlite3'
        self.store = Store(self.path)
        self.pid = self.store.create_product({'name': 'Sony XM5'})
        self.body = dict(url='https://www.ozon.ru/product/sony-123/', seller='Продавец А',
                         price='12000.51', shipping='99.49', days_min=1, days_max=3,
                         city='Санкт-Петербург', terms='Без подписки')

    def tearDown(self):
        self.tmp.cleanup()

    def test_history_persistence_and_multiple_cards_same_market(self):
        oid = self.store.create_offer(self.pid, self.body)
        self.store.create_offer(self.pid, {**self.body, 'url': 'https://www.ozon.ru/product/sony-456/', 'seller': 'Продавец Б'})
        self.store.add_observation(oid, {**self.body, 'price': '11000.01', 'city': 'Москва'})
        product = Store(self.path).snapshot()['products'][0]
        self.assertEqual(len(product['offers']), 2)
        history = product['offers'][0]['history']
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]['price'] + history[0]['shipping'], 1210000)
        self.assertEqual(history[0]['city'], 'Санкт-Петербург')
        self.assertEqual(history[1]['city'], 'Москва')
        self.assertEqual(history[1]['price'], 1100001)

    def test_invalid_data_does_not_leave_partial_card(self):
        for patch in [{'price': 'NaN'}, {'price': '-1'}, {'price': '1.001'}, {'price': 0},
                      {'days_min': 9, 'days_max': 2}, {'days_min': True}, {'shipping': '-10'}, {'city': ''}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.store.create_offer(self.pid, {**self.body, **patch})
        self.assertEqual(self.store.snapshot()['products'][0]['offers'], [])

    def test_url_validation(self):
        for url in ['http://ozon.ru/product/1', 'https://ozon.ru.evil.test/product/1',
                    'https://evil.test', 'https://ozon.ru@evil.test/p', 'https://ozon.ru/',
                    'https://ozon.ru:8080/product/1', 'javascript:alert(1)']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                market_url(url)
        for host, expected in [('www.ozon.ru','ozon'), ('www.wildberries.ru','wb'),
                               ('market.yandex.ru','yandex'), ('aliexpress.ru','ali'), ('www.aliexpress.com','ali')]:
            self.assertEqual(market_url(f'https://{host}/product/123')[0], expected)

    def test_duplicates_and_missing_parent(self):
        self.store.create_offer(self.pid, self.body)
        with self.assertRaises(ValueError):
            self.store.create_offer(self.pid, self.body)
        with self.assertRaises(LookupError):
            self.store.create_offer(999, {**self.body, 'url': 'https://ozon.ru/product/2'})
        with self.assertRaises(LookupError):
            self.store.add_observation(999, self.body)

    def test_delete_cascades(self):
        self.store.create_offer(self.pid, self.body)
        self.store.delete_product(self.pid)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM observations').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM offers').fetchone()[0], 0)

    def test_demo_is_explicit_idempotent_and_read_only(self):
        self.store.demo()
        self.store.demo()
        demo = [p for p in self.store.snapshot()['products'] if p['demo']]
        self.assertEqual(len(demo), 1)
        self.assertEqual(len(demo[0]['offers']), 5)
        self.assertEqual(sum(len(o['history']) for o in demo[0]['offers']), 35)
        self.assertTrue(all(h['source']=='demo' for o in demo[0]['offers'] for h in o['history']))
        with self.assertRaises(ValueError):
            self.store.add_observation(demo[0]['offers'][0]['id'], self.body)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.store = Store(Path(cls.tmp.name) / 'http.sqlite3')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.opener = build_opener(ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.tmp.cleanup()

    def request(self, path, body=None, method=None, origin=None):
        headers={'Content-Type': 'application/json'}
        if origin:
            headers['Origin']=origin
        req=Request(self.base+path, data=json.dumps(body).encode() if body is not None else None,
                    headers=headers, method=method)
        return self.opener.open(req)

    def test_functional_api(self):
        with self.request('/api/products', {'name': 'API товар'}) as r:
            self.assertEqual(r.status, 201)
            pid=json.load(r)['id']
        body=dict(url='https://wildberries.ru/catalog/123/detail.aspx', seller='Магазин',
                  price='950.10', shipping=50, days_min=2, days_max=4, city='Санкт-Петербург')
        with self.request(f'/api/products/{pid}/offers', body) as r:
            oid=json.load(r)['id']
        with self.request(f'/api/offers/{oid}/observations', {**body, 'price': '900.10'}) as r:
            self.assertEqual(r.status, 201)
        with self.request('/api/state') as r:
            p=next(p for p in json.load(r)['products'] if p['id']==pid)
            self.assertEqual([h['price'] for h in p['offers'][0]['history']], [95010,90010])
        with self.request(f'/api/products/{pid}', method='DELETE') as r:
            self.assertEqual(r.status, 200)

    def test_cross_origin_write_rejected(self):
        with self.assertRaises(HTTPError) as e:
            self.request('/api/products', {'name': 'Не создавать'}, origin='https://untrusted.test')
        self.assertEqual(e.exception.code, 403)

    def test_static_and_missing_path(self):
        with self.request('/') as r:
            self.assertIn('Ценоскоп', r.read().decode())
            self.assertIn("default-src 'self'", r.headers['Content-Security-Policy'])
        with self.assertRaises(HTTPError) as e:
            self.request('/../../app.py')
        self.assertEqual(e.exception.code, 404)


if __name__ == '__main__':
    unittest.main()
