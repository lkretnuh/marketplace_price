"""Local price tracker. Python 3.12+, no third-party dependencies."""
import argparse
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
MARKETS = {'ozon': ('ozon.ru',), 'wb': ('wildberries.ru',),
           'yandex': ('market.yandex.ru',), 'ali': ('aliexpress.com', 'aliexpress.ru')}


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def text(value, name, limit=200):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f'{name}: укажите от 1 до {limit} символов')
    return value.strip()


def money(value, name):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or amount > 100_000_000:
            raise ValueError()
        if amount != amount.quantize(Decimal('.01')):
            raise ValueError()
        return int(amount * 100)
    except (ValueError, InvalidOperation):
        raise ValueError(f'{name}: нужна сумма от 0 до 100 000 000 с точностью до копейки') from None


def market_url(value):
    value = text(value, 'Ссылка', 2000)
    parsed = urlparse(value)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Нужна HTTPS-ссылка на карточку маркетплейса')
    host = (parsed.hostname or '').lower()
    for market, domains in MARKETS.items():
        if any(host == domain or host == 'www.' + domain for domain in domains):
            if parsed.path in ('', '/'):
                raise ValueError('Укажите ссылку на карточку, а не главную страницу')
            return market, value
    raise ValueError('Поддерживаются Ozon, Wildberries, Яндекс Маркет и AliExpress')


def observation(body):
    price = money(body.get('price'), 'Цена')
    if price == 0:
        raise ValueError('Цена должна быть больше нуля')
    shipping = money(body.get('shipping', 0), 'Доставка')
    low, high = body.get('days_min'), body.get('days_max')
    if type(low) is not int or type(high) is not int or not 0 <= low <= high <= 365:
        raise ValueError('Срок доставки: от 0 до 365 дней, минимум не больше максимума')
    return price, shipping, low, high, text(body.get('city'), 'Город'), text(body.get('terms', 'Обычная цена'), 'Условия', 500)


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS products(
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS offers(
                    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    market TEXT NOT NULL, url TEXT NOT NULL UNIQUE, seller TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS observations(
                    id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
                    at TEXT NOT NULL, price INTEGER NOT NULL, shipping INTEGER NOT NULL,
                    days_min INTEGER NOT NULL, days_max INTEGER NOT NULL, city TEXT NOT NULL,
                    terms TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual');
                CREATE INDEX IF NOT EXISTS obs_offer ON observations(offer_id, at, id);
            ''')

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def snapshot(self):
        with self.db() as db:
            products = [dict(r) for r in db.execute('SELECT * FROM products ORDER BY id')]
            for product in products:
                product['offers'] = [dict(r) for r in db.execute('SELECT * FROM offers WHERE product_id=? ORDER BY id', (product['id'],))]
                for offer in product['offers']:
                    offer['history'] = [dict(r) for r in db.execute('SELECT * FROM observations WHERE offer_id=? ORDER BY at,id', (offer['id'],))]
            return {'products': products, 'currency': 'RUB', 'automatic_collection': False}

    def create_product(self, body):
        name = text(body.get('name'), 'Название товара')
        with self.db() as db:
            return db.execute('INSERT INTO products(name) VALUES(?)', (name,)).lastrowid

    def create_offer(self, product_id, body):
        market, url = market_url(body.get('url'))
        seller = text(body.get('seller'), 'Продавец')
        values = observation(body)
        with self.db() as db:
            product = db.execute('SELECT demo FROM products WHERE id=?', (product_id,)).fetchone()
            if not product:
                raise LookupError('Товар не найден')
            if product['demo']:
                raise ValueError('Демотовар доступен только для просмотра. Создайте свой товар.')
            try:
                offer_id = db.execute('INSERT INTO offers(product_id,market,url,seller) VALUES(?,?,?,?)', (product_id, market, url, seller)).lastrowid
            except sqlite3.IntegrityError:
                raise ValueError('Эта карточка уже добавлена') from None
            db.execute('INSERT INTO observations(offer_id,at,price,shipping,days_min,days_max,city,terms) VALUES(?,?,?,?,?,?,?,?)', (offer_id, now(), *values))
            return offer_id

    def add_observation(self, offer_id, body):
        values = observation(body)
        with self.db() as db:
            row = db.execute('SELECT p.demo FROM offers o JOIN products p ON p.id=o.product_id WHERE o.id=?', (offer_id,)).fetchone()
            if not row:
                raise LookupError('Карточка не найдена')
            if row['demo']:
                raise ValueError('Демоданные доступны только для просмотра')
            return db.execute('INSERT INTO observations(offer_id,at,price,shipping,days_min,days_max,city,terms) VALUES(?,?,?,?,?,?,?,?)', (offer_id, now(), *values)).lastrowid

    def delete_product(self, product_id):
        with self.db() as db:
            if not db.execute('DELETE FROM products WHERE id=?', (product_id,)).rowcount:
                raise LookupError('Товар не найден')

    def demo(self):
        with self.db() as db:
            if db.execute('SELECT 1 FROM products WHERE demo=1').fetchone():
                return
            pid = db.execute('INSERT INTO products(name,demo) VALUES(?,1)', ('Наушники Sony WH-1000XM5 · чёрные',)).lastrowid
            fixtures = [('ozon', 'Аудио Мир', 27990, 0, 1, 2), ('ozon', 'Sound Store', 26490, 490, 3, 5),
                        ('wb', 'Техника рядом', 28990, 0, 1, 3), ('yandex', 'Hi-Fi магазин', 27490, 299, 2, 4),
                        ('ali', 'Global Audio', 23990, 1200, 14, 24)]
            for index, (market, seller, price, shipping, low, high) in enumerate(fixtures):
                # Demo URLs are never represented as real product links.
                oid = db.execute('INSERT INTO offers(product_id,market,url,seller) VALUES(?,?,?,?)', (pid, market, f'demo:{index}', seller)).lastrowid
                for day, offset in enumerate([3800, 2200, 2900, 1200, 1900, 400, 0]):
                    at = (datetime.now(timezone.utc) - timedelta(days=(6-day)*4)).isoformat()
                    db.execute('INSERT INTO observations(offer_id,at,price,shipping,days_min,days_max,city,terms,source) VALUES(?,?,?,?,?,?,?,?,?)', (oid, at, (price+offset)*100, shipping*100, low, high, 'Санкт-Петербург', 'Демонстрационное предложение', 'demo'))


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type='application/json; charset=utf-8'):
        data = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, (dict, list)) else body
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/state':
            return self.reply(200, self.server.store.snapshot())
        files = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if path in files:
            filename, mime = files[path]
            return self.reply(200, (ROOT / 'web' / filename).read_bytes(), mime)
        self.reply(404, {'error': 'Не найдено'})

    def do_POST(self):
        self.mutate()

    def do_DELETE(self):
        self.mutate()

    def mutate(self):
        # No cross-origin writes; application is for a trusted local user.
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.reply(403, {'error': 'Запрос с другого сайта запрещён'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 16384:
                raise ValueError('Слишком большой запрос')
            body = json.loads(self.rfile.read(size)) if size else {}
            if not isinstance(body, dict):
                raise ValueError('Ожидается JSON-объект')
            parts = urlparse(self.path).path.strip('/').split('/')
            store = self.server.store
            if self.command == 'DELETE' and len(parts) == 3 and parts[:2] == ['api', 'products']:
                store.delete_product(int(parts[2]))
                return self.reply(200, {'ok': True})
            if self.command == 'POST':
                if parts == ['api', 'products']:
                    return self.reply(201, {'id': store.create_product(body)})
                if parts == ['api', 'demo']:
                    store.demo()
                    return self.reply(201, {'ok': True})
                if len(parts) == 4 and parts[:2] == ['api', 'products'] and parts[3] == 'offers':
                    return self.reply(201, {'id': store.create_offer(int(parts[2]), body)})
                if len(parts) == 4 and parts[:2] == ['api', 'offers'] and parts[3] == 'observations':
                    return self.reply(201, {'id': store.add_observation(int(parts[2]), body)})
            self.reply(404, {'error': 'Не найдено'})
        except LookupError as exc:
            self.reply(404, {'error': str(exc)})
        except (ValueError, TypeError) as exc:
            self.reply(400, {'error': str(exc)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--db', default=os.environ.get('PRICE_DB', str(ROOT / 'data' / 'prices.sqlite3')))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.store = Store(args.db)
    print(f'Price tracker listening on {args.host}:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
