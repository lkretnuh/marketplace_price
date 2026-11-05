"""Real unpacked-extension integration on intercepted local fixture pages.

No live marketplace requests. Requires Playwright and Chromium supporting
--load-extension. TEST_CHROMIUM selects a system Chromium binary.
"""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Handler, Store, ThreadingHTTPServer
from market_search import BrowserSearch
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
A = 'https://www.ozon.ru/product/kiwi-123/'
B = 'https://www.ozon.ru/product/kiwi-456/'
W = 'https://www.wildberries.ru/catalog/123/detail.aspx'
Y = 'https://market.yandex.ru/product--kiwi-ears-orchestra-lite/123'


def article(url, title, price, product=None, seller=None, delivery=''):
    return f'''<article><a href="{url}">{title}</a><p>{price} ₽</p>
        {f'<span data-product-rating="{product}">{product}</span>' if product is not None else ''}
        {f'<span data-seller-rating="{seller}">{seller}</span>' if seller is not None else ''}
        <p class="delivery-info">{delivery}</p></article>'''


SEARCH = {
    'www.ozon.ru': article(A, 'Kiwi Blue', '19 990', 4.8, 4.1, 'Доставка 3–5 дней. Доставка 300 ₽') + article(B, 'Kiwi Green', '21 000', 4.5, 4.9, 'Доставка завтра бесплатно'),
    'www.wildberries.ru': article(W, 'Kiwi WB', '20 550', 4.9, 4.3),
    'market.yandex.ru': article(Y, 'Kiwi Yandex', '22 000', 4.6, None, 'Доставка 2–3 дня. Доставка 500 ₽'),
    'aliexpress.ru': '<h1>Подтвердите, что вы человек</h1><p>CAPTCHA</p>',
}
DETAIL = '''<main><h1>Kiwi Ears Orchestra Lite Blue</h1><div data-auto="price-value">18 990 ₽</div>
    <p class="delivery-info">Доставка завтра бесплатно</p>
    <script type="application/ld+json">''' + json.dumps({
        '@type': 'Product', 'url': A, 'name': 'Kiwi Ears Orchestra Lite Blue',
        'aggregateRating': {'ratingValue': '4.7', 'bestRating': '5'},
        'offers': {'price': '18990', 'priceCurrency': 'RUB', 'seller': {'name': 'Audio seller',
                   'aggregateRating': {'ratingValue': '4.6', 'bestRating': '5'}}},
    }) + '</script></main>'


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


def main():
    with tempfile.TemporaryDirectory() as tmp:
        server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        server.store = Store(Path(tmp) / 'prices.sqlite3')
        server.search = BrowserSearch(Path(tmp) / 'unused-profile')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                extension = ROOT / 'chrome-extension'
                options = dict(headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
                if os.environ.get('TEST_CHROMIUM'):
                    options['executable_path'] = os.environ['TEST_CHROMIUM']
                else:
                    options['channel'] = 'chromium'
                context = p.chromium.launch_persistent_context(str(Path(tmp) / 'chrome'), **options)
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=15000)
                errors = []
                def route_request(route):
                    url = urlparse(route.request.url)
                    if url.hostname in ('127.0.0.1', 'localhost'):
                        return route.continue_()
                    body = DETAIL if route.request.url.rstrip('/') == A.rstrip('/') else SEARCH.get(url.hostname, '<p>Unrecognised test page</p>')
                    route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)
                context.route('**/*', route_request)
                old_tab = context.pages[0]
                old_tab.goto(A)
                app = context.new_page()
                app.on('pageerror', lambda error: errors.append(str(error)))
                app_url = f'http://127.0.0.1:{server.server_port}/'
                app.goto(app_url)
                expect(app.locator('#extension-status')).to_contain_text('подключено ·', timeout=10000)
                app_tab = next(tab for tab in worker.evaluate('chrome.tabs.query({})') if tab.get('url') == app_url)
                original_windows = {tab['windowId'] for tab in worker.evaluate('chrome.tabs.query({})')}
                app.locator('#market-query').fill('Kiwi Ears Orchestra Lite')
                app.locator('#run-search').click()
                expect(app.locator('.found-card')).to_have_count(4, timeout=30000)
                all_tabs = worker.evaluate('chrome.tabs.query({})')
                assert {tab['windowId'] for tab in all_tabs} == original_windows
                assert all(tab['windowId'] == app_tab['windowId'] for tab in all_tabs)
                assert len(context.pages) == 6  # existing product + app + four search tabs
                assert 'Проверка доступа' in app.locator('#search-feedback').inner_text()
                for key, url in [('price', A), ('price_desc', Y), ('total', A), ('total_desc', Y),
                                 ('days', B), ('product_rating', W), ('seller_rating', B)]:
                    app.locator('#search-sort').select_option(key)
                    expect(app.locator('.found-card').first).to_have_attribute('data-result-url', url)
                app.locator('#search-sort').select_option('price')
                # Opening a card already present in this window must reuse its tab.
                before = len(context.pages)
                app.locator(f'[data-result-url="{A}"] [data-found-open]').click()
                expect(app.locator(f'[data-result-url="{A}"] strong')).to_contain_text('18', timeout=15000)
                assert len(context.pages) == before
                assert not old_tab.is_closed()
                app.bring_to_front()
                app.locator(f'[data-result-url="{A}"] [data-import-result]').click()
                assert app.locator('[name=price]').input_value() == '18990'
                assert app.locator('[name=shipping]').input_value() == '0'
                assert app.locator('[name=days_max]').input_value() == '1'
                assert app.locator('[name=product_rating]').input_value() == '4.7'
                assert app.locator('[name=seller_rating]').input_value() == '4.6'
                app.locator('[name=terms]').fill('Подтверждённые условия')
                app.locator('#save-button').click()
                expect(app.locator('#stat-offers')).to_have_text('1')
                product = server.store.snapshot()['products'][0]
                assert product['offers'][0]['history'][0]['seller_rating'] == 4.6
                # Confirming the same imported card updates history, not duplicate offers.
                app.locator(f'[data-result-url="{A}"] [data-import-result]').click()
                app.locator('[name=terms]').fill('Второе наблюдение')
                app.locator('#save-button').click()
                expect(app.locator('#stat-history')).to_have_text('2')
                assert len(server.store.snapshot()['products'][0]['offers']) == 1
                # Seed other confirmed offers for UI comparison against the imported one.
                server.store.create_offer(product['id'], dict(url=B, seller='B', price=18000, shipping=2000, days_min=2, days_max=4, city='Санкт-Петербург', product_rating=4.9, seller_rating=4.3))
                server.store.create_offer(product['id'], dict(url=W, seller='W', price=21000, shipping=0, days_min=3, days_max=5, city='Санкт-Петербург', product_rating=None, seller_rating=4.9))
                app.reload()
                expect(app.locator('#stat-offers')).to_have_text('3')
                ids = {offer['seller']: str(offer['id']) for offer in server.store.snapshot()['products'][0]['offers']}
                for key, seller in [('price', 'B'), ('price_desc', 'W'), ('total', 'Audio seller'),
                                    ('total_desc', 'W'), ('days', 'Audio seller'), ('product_rating', 'B'), ('seller_rating', 'W')]:
                    app.locator('#sort').select_option(key)
                    expect(app.locator('.offers-card tbody tr').first).to_have_attribute('data-offer-id', ids[seller])
                app.screenshot(path='/tmp/tsenoskop-extension-desktop.png', full_page=True)
                app.set_viewport_size({'width':390, 'height':844})
                assert app.evaluate('document.documentElement.scrollWidth <= innerWidth')
                app.screenshot(path='/tmp/tsenoskop-extension-mobile.png', full_page=True)
                app.locator('#close-search').click()
                expect(app.locator('#run-search')).to_be_enabled(timeout=15000)
                assert len(context.pages) == before
                assert not old_tab.is_closed()
                assert not errors, errors
                print('PASS: real unpacked MV3 extension; same browser window; existing-tab reuse; DOM + JSON-LD values; 7 result sorts + 7 saved-offer sorts; rating persistence; duplicate-card observation; stop leaves all tabs open; mobile; no JS errors. Fixtures only, no live marketplace validation.')
                context.close()
        finally:
            server.search.close()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
