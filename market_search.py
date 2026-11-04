"""Visible-browser search. No CAPTCHA solving, stealth, or private API calls."""
import copy
import importlib.util
import queue
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlparse

SEARCH_URLS = {
    'ozon': 'https://www.ozon.ru/search/?text={}',
    'wb': 'https://www.wildberries.ru/catalog/0/search.aspx?search={}',
    'yandex': 'https://market.yandex.ru/search?text={}',
    'ali': 'https://aliexpress.ru/wholesale?SearchText={}',
}
HOSTS = {'ozon': ('ozon.ru',), 'wb': ('wildberries.ru',),
         'yandex': ('market.yandex.ru',), 'ali': ('aliexpress.ru', 'aliexpress.com')}
EXTRACT = (Path(__file__).parent / 'search_extract.js').read_text(encoding='utf-8')


def normalize_cards(market, raw):
    """Do not trust scraped URLs or interpret price/delivery without evidence."""
    cards, seen = [], set()
    for item in raw[:200]:
        if not isinstance(item, dict):
            continue
        url = str(item.get('url', ''))
        try:
            parsed = urlparse(url)
            if parsed.port not in (None, 443):
                continue
        except ValueError:
            continue
        if (parsed.scheme != 'https' or parsed.username or parsed.password
                or parsed.hostname not in HOSTS[market] + tuple('www.' + h for h in HOSTS[market])):
            continue
        url = parsed._replace(fragment='').geturl()
        if url in seen:
            continue
        title = str(item.get('title', '')).strip()[:300]
        if not title:
            continue
        seen.add(url)
        # Preserve the displayed price as text. A crossed-out/list/member price
        # cannot safely become a historical observation without confirmation.
        price = str(item.get('price_text', '')).strip()[:100]
        delivery = str(item.get('delivery_text', '')).strip()[:200]
        cards.append({'market': market, 'url': url, 'title': title,
                      'price_text': price or None, 'delivery_text': delivery or None,
                      'seller': str(item.get('seller', '')).strip()[:200] or None})
    return cards


class SearchBusy(ValueError):
    pass


class BrowserSearch:
    """All Playwright calls stay on one worker thread; HTTP only reads copies."""
    def __init__(self, profile_dir):
        self.profile_dir = str(profile_dir)
        self.lock = threading.Lock()
        self.commands = queue.Queue()
        self.job = None
        self.worker = None
        self.stop = threading.Event()

    @staticmethod
    def installed():
        return importlib.util.find_spec('playwright') is not None

    def start(self, query):
        if not self.installed():
            raise RuntimeError('Нужен модуль поиска. Запустите setup-search-windows.bat (Windows) или python3 -m pip install -r requirements-search.txt и python3 -m playwright install chromium.')
        with self.lock:
            if self.job and self.job['status'] not in ('closed', 'error'):
                raise SearchBusy('Поиск уже открыт. Закройте текущее окно поиска кнопкой в приложении.')
            if self.worker and self.worker.is_alive():
                raise SearchBusy('Предыдущее окно ещё закрывается. Повторите через несколько секунд.')
            self.commands = queue.Queue()
            self.stop.clear()
            self.job = {'id': uuid.uuid4().hex, 'query': query, 'status': 'starting',
                        'message': 'Открываю отдельный браузер…', 'markets': {}, 'results': []}
            job_id = self.job['id']
            self.worker = threading.Thread(target=self._run, args=(query,), daemon=True)
            self.worker.start()
            return job_id

    def snapshot(self, job_id=None):
        with self.lock:
            if not self.job or (job_id is not None and job_id != self.job['id']):
                raise LookupError('Поиск не найден. Запустите новый поиск.')
            return copy.deepcopy(self.job)

    def command(self, job_id, action):
        job = self.snapshot(job_id)
        if job['status'] in ('closed', 'error'):
            raise ValueError('Этот поиск уже завершён')
        if action not in ('collect', 'close'):
            raise ValueError('Неизвестное действие поиска')
        if action == 'close':
            self.stop.set()
        self.commands.put(action)

    def close(self):
        self.stop.set()
        self.commands.put('close')

    def _update(self, **kwargs):
        with self.lock:
            self.job.update(kwargs)

    def _collect(self, pages, failures):
        results, statuses = [], {}
        for market, page in pages.items():
            if page.is_closed():
                statuses[market] = {'status': 'closed', 'message': 'Вкладка закрыта', 'count': 0}
                continue
            try:
                extracted = page.evaluate(EXTRACT, market)
                cards = normalize_cards(market, extracted.get('cards', []))
                results.extend(cards)
                if cards:
                    status, message = 'ok', 'Получены карточки с открытой страницы'
                elif extracted.get('blocked'):
                    status, message = 'attention', 'Проверка доступа или вход. Откройте вкладку браузера и выполните её вручную.'
                elif extracted.get('empty'):
                    status, message = 'empty', 'На открытой странице показано, что ничего не найдено'
                else:
                    status, message = 'unreadable', 'Карточки не прочитаны: страница ещё загружается, доступ ограничен или её разметка не поддерживается. Это не означает отсутствие товара.'
                statuses[market] = {'status': status, 'message': message, 'count': len(cards)}
            except Exception:
                statuses[market] = {'status': 'error', 'message': 'Не удалось прочитать вкладку. Проверьте её в браузере.', 'count': 0}
        for market in SEARCH_URLS:
            if market not in pages:
                statuses[market] = {'status': 'error', 'message': failures.get(market, 'Вкладка недоступна'), 'count': 0}
        self._update(status='ready', message='Результаты открытых страниц. При необходимости выберите Санкт-Петербург в каждой вкладке. Совпадение модели и условия цены нужно проверить.',
                     markets=statuses, results=results, updated_at=time.time())

    def _run(self, query):
        context = None
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as playwright:
                Path(self.profile_dir).mkdir(parents=True, exist_ok=True)
                try:
                    context = playwright.chromium.launch_persistent_context(self.profile_dir, headless=False, viewport={'width': 1280, 'height': 900})
                except Exception:
                    self._update(status='error', message='Браузер поиска не запустился. Закройте старое окно поиска и выполните python -m playwright install chromium тем же Python, которым запускаете приложение. В Windows используйте setup-search-windows.bat.')
                    return
                pages, failures = {}, {}
                for market, template in SEARCH_URLS.items():
                    if self.stop.is_set():
                        self._update(status='closed', message='Поиск закрыт')
                        return
                    self._update(message='Открываю поиск: ' + market)
                    page = context.new_page()
                    pages[market] = page
                    try:
                        page.goto(template.format(quote(query, safe='')), wait_until='domcontentloaded', timeout=20000)
                    except Exception:
                        # Keep the tab: it may complete loading or require user action.
                        failures[market] = 'Страница не загрузилась за 20 секунд'
                deadline = time.monotonic() + 15 * 60
                self._collect(pages, failures)
                while time.monotonic() < deadline and not self.stop.is_set():
                    try:
                        action = self.commands.get(timeout=8)
                    except queue.Empty:
                        action = 'collect'
                    if action == 'close' or not any(not page.is_closed() for page in pages.values()):
                        break
                    self._collect(pages, failures)
                self._update(status='closed', message='Окно поиска закрыто. Последние результаты сохранены до нового поиска или перезапуска приложения.')
        except Exception:
            self._update(status='error', message='Ошибка модуля поиска. Проверьте установку Playwright и перезапустите приложение.')
        finally:
            if context:
                try:
                    context.close()
                except Exception:
                    pass
