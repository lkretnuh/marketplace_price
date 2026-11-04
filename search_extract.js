// Read only rendered product cards. Do not call internal APIs or solve challenges.
(market) => {
  const bodyText = document.body?.innerText || '';
  const patterns = {
    ozon: /\/product\/[^/?#]+/,
    wb: /\/catalog\/\d+\/detail\.aspx/,
    yandex: /\/(?:product--[^/]+|card|offer)\//,
    ali: /\/item\/[^/?#]+/
  };
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const cards = [], seen = new Set();
  for (const link of document.querySelectorAll('a[href]')) {
    if (!patterns[market]?.test(link.pathname) || !link.getClientRects().length) continue;
    const url = new URL(link.href);
    // Tracking parameters are not product identity. Keep SKU variants on Yandex/Ali.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|from$|sh$|oos_search$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    if (seen.has(url.href)) continue;
    let container = link.closest('article, [data-auto="snippet"], .product-card, .product-snippet, [data-index]');
    if (!container) {
      // Walk only within a single product, never take prices from the whole list.
      container = link;
      for (let i = 0; i < 6 && container.parentElement; i++) {
        const parent = container.parentElement;
        const identities = new Set([...parent.querySelectorAll('a[href]')].filter(a => patterns[market].test(a.pathname)).map(a => a.pathname));
        if (identities.size > 1 || parent === document.body) break;
        container = parent;
        if (/\d[\d\s\u00a0]*(?:₽|руб\.?)/i.test(container.innerText)) break;
      }
    }
    const visible = clean(container.innerText);
    const title = clean(link.getAttribute('title') || link.getAttribute('aria-label') ||
      container.querySelector('.product-card__name, [data-auto="snippet-title"], h3')?.textContent ||
      link.innerText || link.querySelector('img')?.alt || container.querySelector('img')?.alt);
    if (!title || title.length < 3 || /^(в корзину|купить|подробнее)$/i.test(title)) continue;
    const priceNode = container.querySelector('.price__lower-price, [data-auto="snippet-price-current"], [data-auto="price-value"]');
    const explicit = clean(priceNode?.innerText);
    // Only mark an explicitly labelled currency as RUB. Never infer AliExpress currency.
    const matches = visible.match(/\d[\d\s\u00a0]*(?:[.,]\d{1,2})?\s*(?:₽|руб\.?)/gi) || [];
    const priceText = /₽|руб/i.test(explicit) ? explicit : matches[0] || '';
    const deliveryText = visible.match(/(?:доставк[а-я]*|получ[а-я]*|привез[а-я]*|завтра|послезавтра)[^.!?]{0,90}/i)?.[0] || '';
    const seller = clean(container.querySelector('[data-auto="shop-name"], .product-card__seller')?.textContent);
    seen.add(url.href);
    cards.push({url:url.href, title, price_text:priceText, delivery_text:clean(deliveryText), seller});
    if (cards.length >= 60) break;
  }
  return {cards,
    blocked: /captcha|подтвердите.{0,30}(?:человек|робот)|проверка.{0,20}браузера|доступ.{0,15}ограничен|access denied|verify.{0,20}human/i.test(bodyText),
    empty: /ничего не найдено|товары не найдены|no results found/i.test(bodyText)};
}
