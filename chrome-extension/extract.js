// Shared by the Chrome extension and optional Playwright collector.
// Reads public page data only; no private APIs, cookies, or CAPTCHA handling.
globalThis.TsenoskopExtract = (market) => {
  const bodyText=document.body?.innerText||'';
  const blocked=/captcha|подтвердите.{0,30}(?:человек|робот)|проверка.{0,20}браузера|доступ.{0,15}ограничен|access denied|verify.{0,20}human/i.test(bodyText);
  if(blocked)return {cards:[],blocked:true,empty:false};
  const patterns = {ozon:/\/product\/[^/?#]+/, wb:/\/catalog\/\d+\/detail\.aspx/,
    yandex:/\/(?:product--[^/]+|card|offer)\//, ali:/\/item\/[^/?#]+/};
  const pattern = patterns[market];
  const clean = value => String(value || '').replace(/\s+/g,' ').trim();
  const visible = node => !!node?.getClientRects().length;
  const textOf = node => clean(node?.getAttribute('content') || node?.innerText || '');
  const first = (root, selectors) => [...root.querySelectorAll(selectors)].find(visible);
  const canonical = value => {
    const url = new URL(value, location.href);
    for(const key of [...url.searchParams.keys()]) {
      if(/^(utm_|from$|sh$|oos_search$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash='';return url.href;
  };
  const score = (value, scale=5) => {
    if(Number(scale)!==5) return null;
    const match=clean(value).match(/^(?:★\s*)?(?:рейтинг(?:\s+товара|\s+продавца)?\s*[:—-]?\s*)?([0-5](?:[.,]\d{1,2})?)(?![\d.,])/i);
    if(!match || /%/.test(value)) return null;
    const number=Number(match[1].replace(',','.'));
    return number>=0 && number<=5 ? number : null;
  };
  const labelled = (value, label) => {
    const match=value.match(new RegExp('рейтинг\\s+(?:'+label+')\\s*[:—-]?\\s*(\\d(?:[.,]\\d{1,2})?)(?![\\d.,])','i'));
    return match ? score(match[1]) : null;
  };
  const productData = () => {
    const candidates=[];
    const visit=value=>{
      if(Array.isArray(value)){value.slice(0,100).forEach(visit);return;}
      if(!value||typeof value!=='object')return;
      if([value['@type']].flat().includes('Product'))candidates.push(value);
      if(value['@graph'])visit(value['@graph']);
    };
    for(const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,20)){
      if(script.textContent.length>500000)continue;
      try{visit(JSON.parse(script.textContent));}catch{}
    }
    return candidates.find(p=>{
      if(p.url){try{return new URL(p.url,location.href).pathname===location.pathname;}catch{return false;}}
      return clean(p.name).toLocaleLowerCase()===clean(document.querySelector('h1')?.innerText).toLocaleLowerCase();
    });
  };
  const makeCard = (url,title,root,detail=false) => {
    const text=clean(root.innerText);
    const structured=detail?productData():null;
    const offer=structured && !Array.isArray(structured.offers) ? structured.offers : null;
    const sellerData=offer?.seller;
    const priceNode=first(root,'.price__lower-price, .price-block__final-price, [data-auto="snippet-price-current"], [data-auto="price-value"], [data-widget="webPrice"]');
    const priceSource=textOf(priceNode);
    const priceMatch=priceSource.match(/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:₽|руб\.?)/i)
      || (!detail?text.match(/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:₽|руб\.?)/i):null);
    let priceText=priceMatch?.[0]||'';
    if(!priceText && offer?.priceCurrency==='RUB' && /^\d+(?:[.,]\d{1,2})?$/.test(String(offer.price)))priceText=offer.price+' ₽';
    const deliveryNode=first(root,'[data-auto="delivery-info"], [data-auto="delivery"], [data-widget="webDelivery"], .product-page__delivery, .delivery-info, [data-delivery]');
    let delivery=textOf(deliveryNode);
    if(!delivery){
      const snippets=[...root.querySelectorAll('p,span')].filter(visible).map(n=>clean(n.innerText))
        .filter(v=>v.length<=200 && /доставк|получение|привез|завтра/i.test(v));
      delivery=snippets.slice(0,3).join('. ');
    }
    if(!delivery && !detail)delivery=text.match(/(?:доставк[а-я]*|получ[а-я]*|привез[а-я]*|завтра|послезавтра)[^.!?]{0,140}/i)?.[0]||'';
    const productRatingNode=first(root,'[data-product-rating], .product-card__rating, [data-auto="product-rating"], [data-auto="rating-value"]');
    const sellerRatingNode=first(root,'[data-seller-rating], .product-card__seller-rating, [data-auto="shop-rating"], [data-auto="seller-rating"]');
    const productRating=productRatingNode?score(productRatingNode.getAttribute('data-product-rating')||textOf(productRatingNode)):
      structured?.aggregateRating?score(structured.aggregateRating.ratingValue,structured.aggregateRating.bestRating??5):labelled(text,'товара');
    const sellerRating=sellerRatingNode?score(sellerRatingNode.getAttribute('data-seller-rating')||textOf(sellerRatingNode)):
      sellerData?.aggregateRating?score(sellerData.aggregateRating.ratingValue,sellerData.aggregateRating.bestRating??5):labelled(text,'продавца|магазина');
    const seller=clean(textOf(first(root,'[data-auto="shop-name"], [data-auto="seller-name"], .product-card__seller')) || sellerData?.name);
    return {url:canonical(url),title:clean(title).slice(0,300),price_text:priceText.slice(0,100),detail,
      delivery_text:delivery.slice(0,300),seller:seller.slice(0,200),product_rating:productRating,seller_rating:sellerRating};
  };
  const cards=[],seen=new Set();
  if(pattern?.test(location.pathname) && visible(document.querySelector('h1'))){
    const heading=document.querySelector('h1');
    const root=heading.closest('main, [data-widget="webProductMain"], .product-page')||document.body;
    cards.push(makeCard(location.href,heading.innerText,root,true));
  }else if(pattern){
    for(const link of document.querySelectorAll('a[href]')){
      if(!pattern.test(link.pathname)||!visible(link))continue;
      const url=canonical(link.href);if(seen.has(url))continue;
      let root=link.closest('article, [data-auto="snippet"], .product-card, .product-snippet, [data-index]');
      if(!root){
        root=link;
        for(let i=0;i<6 && root.parentElement;i++){
          const parent=root.parentElement;
          const identities=new Set([...parent.querySelectorAll('a[href]')].filter(a=>pattern.test(a.pathname)).map(a=>a.pathname));
          if(identities.size>1 || parent===document.body)break;
          root=parent;if(/\d[\d\s]*\s*(?:₽|руб)/i.test(root.innerText))break;
        }
      }
      const title=clean(link.title||link.getAttribute('aria-label')||root.querySelector('.product-card__name, [data-auto="snippet-title"], h3')?.textContent||link.innerText||link.querySelector('img')?.alt||root.querySelector('img')?.alt);
      if(title.length<3||/^(в корзину|купить|подробнее)$/i.test(title))continue;
      seen.add(url);cards.push(makeCard(url,title,root));if(cards.length>=60)break;
    }
  }
  return {cards,
    blocked:false,
    empty:/ничего не найдено|товары не найдены|no results found/i.test(bodyText)};
};
