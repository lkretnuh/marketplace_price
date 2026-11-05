"""Conservative normalization of displayed values; missing is never zero."""
import math
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation


def rating(value):
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        raise ValueError('Рейтинг должен быть числом от 0 до 5 или пустым')
    try:
        number = float(str(value).replace(',', '.'))
    except (ValueError, TypeError):
        raise ValueError('Рейтинг должен быть числом от 0 до 5 или пустым') from None
    if not math.isfinite(number) or not 0 <= number <= 5:
        raise ValueError('Рейтинг должен быть числом от 0 до 5 или пустым')
    return number


def rubles(value, allow_zero=False):
    """Require the currency, not just the first number of a text fragment."""
    match = re.fullmatch(r'\s*(\d[\d\s\u00a0\u202f]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?)\s*', str(value), re.I)
    if not match:
        return None
    try:
        amount = Decimal(re.sub(r'\s', '', match[1]).replace(',', '.'))
        if not (0 <= amount <= 100_000_000 and (amount > 0 or allow_zero)):
            return None
        return int(amount * 100)
    except InvalidOperation:
        return None


def delivery_values(value, today=None):
    text = ' '.join(str(value or '').lower().split())
    low = high = shipping = None
    explicit = re.search(r'(?<!\d)(\d{1,3})\s*(?:[–—-]|до)\s*(\d{1,3})(?!\d)\s*(?:календарных\s+)?д(?:ень|ня|ней)', text)
    single = re.search(r'(?:через\s+|срок\s*[:—-]?\s*|доставка\s*[:—-]?\s*)(\d{1,3})\s*д(?:ень|ня|ней)', text)
    if explicit:
        low, high = int(explicit[1]), int(explicit[2])
    elif single:
        low = high = int(single[1])
    elif re.search(r'\bпослезавтра\b', text):
        low = high = 2
    elif re.search(r'\bзавтра\b', text):
        low = high = 1
    elif re.search(r'\bсегодня\b', text):
        low = high = 0
    else:
        # Explicit day + Russian month, e.g. «доставка 10–12 ноября».
        months = ('январ', 'феврал', 'март', 'апрел', 'мая', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр')
        match = re.search(r'\b(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?\s+(' + '|'.join(months) + r')[а-я]*\b(?:\s+(\d{4}))?', text)
        if match and not re.match(r'\s*[–—-]\s*\d', text[match.end():]):
            today = today or datetime.now(timezone(timedelta(hours=3))).date()
            month = months.index(match[3]) + 1
            try:
                year = int(match[4]) if match[4] else today.year
                first = datetime(year, month, int(match[1])).date()
                last = datetime(year, month, int(match[2] or match[1])).date()
                if not match[4] and last < today and today.month == 12 and month == 1:
                    first = first.replace(year=today.year + 1)
                    last = last.replace(year=today.year + 1)
                low, high = (first - today).days, (last - today).days
            except ValueError:
                pass
    if low is not None and not 0 <= low <= high <= 365:
        low = high = None
    if re.search(r'бесплатн[а-я]*\s+доставк|доставк[а-я]*\s*(?:(?:сегодня|послезавтра|завтра)\s*)?[:—-]?\s*бесплатн', text):
        shipping = 0
    else:
        cost = re.search(r'(?:стоимость\s+доставки|доставка)\s*[:—-]?\s*(\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:₽|руб\.?))', text)
        if cost:
            shipping = rubles(cost[1], allow_zero=True)
    return {'days_min': low, 'days_max': high, 'shipping_minor': shipping}
