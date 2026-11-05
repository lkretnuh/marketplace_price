"""Integration check on local fixture pages, not a live-marketplace validation.

Requires Playwright and Chromium. Set TEST_CHROMIUM=/usr/bin/chromium to use
a system installation; otherwise run python -m playwright install chromium.
"""
import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Handler, Store, ThreadingHTTPServer
from market_search import BrowserSearch
from playwright.sync_api import BrowserType, expect, sync_playwright


FIXTURES = {
    'www.ozon.ru': '''<html><body><article><a href="https://www.ozon.ru/product/kiwi-123/">Kiwi Ears Orchestra Lite Blue</a><p>19 990 ₽</p><p>Доставка завтра</p></article>
        <article><a href="https://www.ozon.ru/product/kiwi-456/">Kiwi Ears Orchestra Lite Green</a><p>21 000 ₽</p></article></body></html>''',
    'www.wildberries.ru': '''<html><body><article class="product-card"><a title="Kiwi Ears Orchestra Lite" href="https://www.wildberries.ru/catalog/123/detail.aspx">Kiwi</a><ins class="price__lower-price">20 550 ₽</ins></article></body></html>''',
    'market.yandex.ru': '''<html><body><article data-auto="snippet"><a href="https://market.yandex.ru/product--kiwi-ears-orchestra-lite/123"><h3>Kiwi Ears Orchestra Lite</h3></a><div data-auto="snippet-price-current">22 000 ₽</div></article></body></html>''',
    'aliexpress.ru': '<html><body><h1>Подтвердите, что вы человек</h1><p>CAPTCHA</p></body></html>',
}
original_launch = BrowserType.launch_persistent_context


def fixture_context(browser_type, *args, **kwargs):
    kwargs['headless'] = True
    if os.environ.get('TEST_CHROMIUM'):
        kwargs['executable_path'] = os.environ['TEST_CHROMIUM']
    context = original_launch(browser_type, *args, **kwargs)
    context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8',
                  body=FIXTURES.get(urlparse(route.request.url).hostname, '<html></html>')))
    return context


def main():
    with tempfile.TemporaryDirectory() as tmp, patch.object(BrowserType, 'launch_persistent_context', fixture_context):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.store = Store(Path(tmp) / 'prices.sqlite3')
        server.search = BrowserSearch(Path(tmp) / 'profile')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                options = {'headless': True}
                if os.environ.get('TEST_CHROMIUM'):
                    options['executable_path'] = os.environ['TEST_CHROMIUM']
                browser = p.chromium.launch(**options)
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(f'http://127.0.0.1:{server.server_port}')
                page.locator('#search-mode').select_option('browser')
                page.locator('#market-query').fill('Kiwi Ears Orchestra Lite')
                page.get_by_role('button', name='Найти карточки', exact=True).click()
                page.locator('.found-card').nth(3).wait_for(timeout=30000)
                assert page.locator('.found-card').count() == 4
                assert page.locator('.source-status').count() == 4
                assert 'Проверка доступа' in page.locator('#search-feedback').inner_text()
                assert page.locator('#stat-products').inner_text() == '1'
                # A refused second search must not reassign old results to a new product.
                page.locator('#new-product').click()
                page.locator('[name=name]').fill('Другой товар')
                page.locator('#save-button').click()
                page.locator('#stat-products').filter(has_text='2').wait_for()
                page.locator('[data-import-result="0"]').click()
                assert page.locator('[name=price]').input_value() == '19990', (page.locator('[name=price]').input_value(), server.search.snapshot()['results'])
                assert page.locator('[name=shipping]').input_value() == ''
                assert page.locator('[name=days_min]').input_value() == '1'
                page.locator('[name=shipping]').fill('100')
                page.locator('[name=days_min]').fill('2')
                page.locator('[name=days_max]').fill('4')
                page.locator('[name=terms]').fill('Подтверждённая цена теста')
                page.locator('#save-button').click()
                page.locator('#stat-offers').filter(has_text='1').wait_for()
                page.get_by_role('heading', name='Журнал наблюдений').wait_for()
                assert page.locator('.history-card tbody tr').count() == 1
                products=server.store.snapshot()['products']
                assert len(next(p for p in products if p['name']=='Kiwi Ears Orchestra Lite')['offers'])==1
                assert len(next(p for p in products if p['name']=='Другой товар')['offers'])==0
                page.reload()
                page.locator('.found-card').nth(3).wait_for(timeout=10000)
                page.screenshot(path='/tmp/price-search-desktop.png', full_page=True)
                page.set_viewport_size({'width':390, 'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path='/tmp/price-search-mobile.png', full_page=True)
                page.locator('#close-search').click()
                page.locator('#run-search').wait_for(state='visible')
                expect(page.locator('#run-search')).to_be_enabled(timeout=20000)
                assert not errors, errors
                print('PASS: browser-backed search across fixtures; 4 cards including 2 Ozon; challenge status; import; unknown delivery; persistent history; reload; mobile; close. No JavaScript errors. Live sites not tested.')
                browser.close()
        finally:
            server.search.close()
            if server.search.worker:
                server.search.worker.join(timeout=10)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
