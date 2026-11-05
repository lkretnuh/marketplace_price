"""Real DOM/UI integration with the real app bridge and mocked Chrome transport.

The managed browser forbids loading unpacked extensions. This test does not
change that policy and does NOT validate extension installation or Chrome APIs.
The worker's Chrome API contract is tested separately in extension.test.cjs.
"""
import asyncio
import os
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Store, ThreadingHTTPServer
from market_search import BrowserSearch, EXTRACT, SEARCH_URLS
from extension_smoke import A, B, W, Y, DETAIL, SEARCH, QuietHandler, ROOT
from playwright.async_api import async_playwright, expect


async def main():
    with tempfile.TemporaryDirectory() as tmp:
        server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        server.store = Store(Path(tmp) / 'prices.sqlite3')
        server.search = BrowserSearch(Path(tmp) / 'unused-profile')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            async with async_playwright() as p:
                options = {'headless': True}
                if os.environ.get('TEST_CHROMIUM'):
                    options['executable_path'] = os.environ['TEST_CHROMIUM']
                browser = await p.chromium.launch(**options)
                context = await browser.new_context(viewport={'width':1440,'height':1000})
                async def route_request(route):
                    url = urlparse(route.request.url)
                    if url.hostname in ('127.0.0.1', 'localhost'):
                        return await route.continue_()
                    body = DETAIL if route.request.url.rstrip('/') == A.rstrip('/') else SEARCH.get(url.hostname, '<p>Test page</p>')
                    await route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)
                await context.route('**/*', route_request)
                lease = {}
                async def publish(app, page, market):
                    extracted = await page.evaluate(EXTRACT, market)
                    await app.evaluate('message=>globalThis.__testListeners.forEach(listener=>listener(message))',
                                       {'channel':'tsenoskop-result','jobId':lease['jobId'],'market':market,'extracted':extracted})
                async def transport(source, message):
                    action, payload = message.get('action'), message.get('payload', {})
                    if action == 'ping':
                        return {'ok':True, 'data':{'version':'0.3.0-test-transport'}}
                    if action == 'start':
                        lease.update(payload)
                        for market, template in SEARCH_URLS.items():
                            page = await context.new_page()
                            await page.goto(template.format(quote(payload['query'])))
                            await publish(source['page'], page, market)
                    elif action == 'open-card':
                        page = next((page for page in context.pages if page.url == payload['url']), None)
                        if page is None:
                            page = await context.new_page()
                            await page.goto(payload['url'])
                        await publish(source['page'], page, 'ozon')
                    elif action == 'stop':
                        lease.clear()
                    return {'ok':True,'data':{}}
                await context.expose_binding('__testExtensionTransport', transport)
                shim = """if(['localhost','127.0.0.1'].includes(location.hostname)){
                  globalThis.__testListeners=[];
                  globalThis.chrome={runtime:{sendMessage:message=>globalThis.__testExtensionTransport(message),
                    onMessage:{addListener:listener=>globalThis.__testListeners.push(listener)}}};
                }"""
                await context.add_init_script(shim+'\n'+(ROOT/'chrome-extension'/'app-bridge.js').read_text())
                old = await context.new_page()
                await old.goto(A)
                app = await context.new_page()
                errors = []
                app.on('pageerror', lambda error: errors.append(str(error)))
                await app.goto(f'http://127.0.0.1:{server.server_port}/')
                await expect(app.locator('#extension-status')).to_contain_text('подключено ·', timeout=10000)
                await app.locator('#market-query').fill('Kiwi Ears Orchestra Lite')
                await app.locator('#run-search').click()
                await expect(app.locator('.found-card')).to_have_count(4, timeout=20000)
                assert 'Проверка доступа' in await app.locator('#search-feedback').inner_text()
                for key, url in [('price',A),('price_desc',Y),('total',A),('total_desc',Y),('days',B),('product_rating',W),('seller_rating',B)]:
                    await app.locator('#search-sort').select_option(key)
                    await expect(app.locator('.found-card').first).to_have_attribute('data-result-url',url)
                count = len(context.pages)
                await app.locator(f'[data-result-url="{A}"] [data-found-open]').click()
                await expect(app.locator(f'[data-result-url="{A}"] strong')).to_contain_text('18',timeout=10000)
                assert len(context.pages) == count
                await app.locator(f'[data-result-url="{A}"] [data-import-result]').click()
                for name, value in [('price','18990'),('shipping','0'),('days_max','1'),('product_rating','4.7'),('seller_rating','4.6')]:
                    assert await app.locator(f'[name={name}]').input_value() == value
                await app.locator('[name=terms]').fill('Подтверждённые условия')
                await app.locator('#save-button').click()
                await expect(app.locator('#stat-history')).to_have_text('1')
                await app.locator(f'[data-result-url="{A}"] [data-import-result]').click()
                await app.locator('[name=terms]').fill('Второе наблюдение')
                await app.locator('#save-button').click()
                await expect(app.locator('#stat-history')).to_have_text('2')
                product = server.store.snapshot()['products'][0]
                assert len(product['offers']) == 1
                assert product['offers'][0]['history'][-1]['seller_rating'] == 4.6
                server.store.create_offer(product['id'], dict(url=B,seller='B',price=18000,shipping=2000,days_min=2,days_max=4,city='Санкт-Петербург',product_rating=4.9,seller_rating=4.3))
                server.store.create_offer(product['id'], dict(url=W,seller='W',price=21000,shipping=0,days_min=3,days_max=5,city='Санкт-Петербург',product_rating=None,seller_rating=4.9))
                await app.reload()
                await expect(app.locator('#stat-offers')).to_have_text('3')
                ids = {offer['seller']:str(offer['id']) for offer in server.store.snapshot()['products'][0]['offers']}
                for key,seller in [('price','B'),('price_desc','W'),('total','Audio seller'),('total_desc','W'),('days','Audio seller'),('product_rating','B'),('seller_rating','W')]:
                    await app.locator('#sort').select_option(key)
                    await expect(app.locator('.offers-card tbody tr').first).to_have_attribute('data-offer-id',ids[seller])
                await app.screenshot(path='/tmp/tsenoskop-extension-desktop.png',full_page=True)
                await app.set_viewport_size({'width':390,'height':844})
                assert await app.evaluate('document.documentElement.scrollWidth <= innerWidth')
                await app.screenshot(path='/tmp/tsenoskop-extension-mobile.png',full_page=True)
                await app.locator('#close-search').click()
                await expect(app.locator('#run-search')).to_be_enabled(timeout=10000)
                assert not old.is_closed() and len(context.pages) == count
                assert not errors, errors
                print('PASS: real DOM extractor + app bridge + HTTP/UI with mocked Chrome transport; 7 found and 7 saved sorts, two distinct ratings, duplicate-card history, parsed/free/unknown delivery, mobile. Extension installation and live sites NOT tested.')
                await browser.close()
        finally:
            server.search.close()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    asyncio.run(main())
