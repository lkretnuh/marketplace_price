'use strict';
const $ = selector => document.querySelector(selector);
const names = {ozon:'Ozon',wb:'Wildberries',yandex:'Яндекс Маркет',ali:'AliExpress'};
const colors = {ozon:'#3978ef',wb:'#b454c7',yandex:'#dba72b',ali:'#ee7651'};
const rub = value => new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(value/100);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Date(value).toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'Europe/Moscow'});
const stamp = value => new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'});
let state = {products:[]}, selected = null, filter = '', period = 30, city = 'Санкт-Петербург', market = '', sort = 'total';
let submitAction = null;
let searchJob = null, searchTimer = null, searchStarting = false, searchProductId = null;
let searchSort='price';
const extensionPending=new Map();
let receiveQueue=Promise.resolve();
const ratingText=value=>typeof value==='number'?value.toLocaleString('ru-RU',{maximumFractionDigits:2})+' / 5':'Нет данных';
const sortOptions=selected=>PriceCompare.options.map(([value,label])=>`<option value="${value}" ${value===selected?'selected':''}>${label}</option>`).join('');
function cardIdentity(value){
  const url=new URL(value);url.hostname=url.hostname.replace(/^www\./,'');url.hash='';
  for(const key of [...url.searchParams.keys()])if(/^(utm_|from$|sh$|oos_search$)/i.test(key))url.searchParams.delete(key);
  return url.href;
}
function extensionRequest(action,payload={},timeout=3000){
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{extensionPending.delete(id);reject(new Error('Расширение не отвечает. Установите папку chrome-extension через chrome://extensions, разрешите доступ к сайтам и обновите Ценоскоп (Ctrl+F5).'));},timeout);
    extensionPending.set(id,{resolve,reject,timer});
    window.postMessage({source:'tsenoskop-app',id,action,payload},location.origin);
  });
}
window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.source!=='tsenoskop-extension')return;
  const {id,response,result}=event.data;
  if(id&&extensionPending.has(id)){
    const request=extensionPending.get(id);clearTimeout(request.timer);extensionPending.delete(id);
    if(response?.ok)request.resolve(response.data);else request.reject(new Error(response?.error||'Ошибка расширения'));
  }
  if(result&&searchJob?.mode==='extension'&&searchJob.id===result.jobId&&!['closed','error'].includes(searchJob.status)){
    receiveQueue=receiveQueue.then(()=>api('/api/search/'+encodeURIComponent(result.jobId)+'/results',{market:result.market,extracted:result.extracted})).catch(error=>toast(error.message));
  }
});
async function checkExtension(){
  try{const answer=await extensionRequest('ping');$('#extension-status').textContent='Расширение подключено · '+answer.version;return true;}
  catch{$('#extension-status').textContent='Расширение не подключено — инструкция ниже';return false;}
}
async function openTrackedCard(event,url,productId){
  if($('#search-mode').value!=='extension')return;
  event.preventDefault();
  try{
    if(searchJob?.mode==='extension'&&!['closed','error'].includes(searchJob.status)&&searchProductId===productId){
      await extensionRequest('open-card',{jobId:searchJob.id,url},10000);
    }else{
      const product=state.products.find(p=>p.id===productId);
      if(!product)throw new Error('Сначала выберите товар');
      await startSearch(product.name,productId,url);
    }
  }catch(error){toast(error.message);}
}
async function api(path, body, method='POST') {
  const response = await fetch(path, {method,headers:{'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('#toast').hidden=true,4500); }
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Не удалось загрузить данные');
  state = await response.json();
  if (!state.products.some(p=>p.id===selected)) selected=state.products[0]?.id ?? null;
  render();
}
function latest(offer) { return offer.history.filter(h=>h.city===city).at(-1); }
function render() {
  const offers = state.products.flatMap(p=>p.offers);
  $('#stat-products').textContent=state.products.length;
  $('#stat-offers').textContent=offers.length;
  $('#stat-history').textContent=offers.reduce((n,o)=>n+o.history.length,0);
  $('#stat-markets').innerHTML=`${new Set(offers.map(o=>o.market)).size} <em>/ 4</em>`;
  $('#product-count').textContent=state.products.length;
  const products = state.products.filter(p=>p.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  $('#list-count').textContent=products.length;
  $('#product-list').innerHTML=products.map(p=>{
    const observations=p.offers.map(latest).filter(Boolean);
    const min = observations.length ? Math.min(...observations.map(o=>o.price+o.shipping)) : null;
    return `<button class="product-card ${p.id===selected?'active':''}" data-product="${p.id}">${p.demo?'<span class="demo-tag">ДЕМОНСТРАЦИЯ</span>':''}<strong>${esc(p.name)}</strong><span class="product-meta"><span>${p.offers.length} карточек</span><span>${min!==null?rub(min):'Нет цен'}</span></span></button>`;
  }).join('') || '<p class="list-empty">'+(filter?'Ничего не найдено в вашем списке.':'Добавьте первый товар или откройте демо.')+'</p>';
  document.querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>{selected=Number(b.dataset.product);market='';render();});
  renderDetail();
}
function searchLinks(query) {
  const q=encodeURIComponent(query);
  return [['Ozon',`https://www.ozon.ru/search/?text=${q}`],['Wildberries',`https://www.wildberries.ru/catalog/0/search.aspx?search=${q}`],['Яндекс Маркет',`https://market.yandex.ru/search?text=${q}`],['AliExpress',`https://aliexpress.ru/wholesale?SearchText=${q}`]].map(([name,url])=>`<a class="search-market" target="_blank" rel="noopener noreferrer" href="${url}">${name} ↗</a>`).join('');
}
function renderDetail() {
  const product = state.products.find(p=>p.id===selected);
  if (!product) {
    $('#detail').innerHTML='<div class="empty"><strong>Ваша следующая выгодная покупка — здесь</strong>Создайте товар по названию, найдите предложения на площадках<br>и сохраните цены и доставку для сравнения.<br><button class="primary" id="empty-add">＋ Найти товар</button></div>';
    $('#empty-add').onclick=newProduct;return;
  }
  const cities=[...new Set(['Санкт-Петербург',...product.offers.flatMap(o=>o.history.map(h=>h.city))])];
  if(!cities.includes(city)) cities.push(city);
  const offers=PriceCompare.sort(product.offers.filter(o=>(!market||o.market===market)&&latest(o)),sort,latest);
  const best=offers.length?Math.min(...offers.map(o=>latest(o).price+latest(o).shipping)):null;
  $('#detail').innerHTML=`<div class="detail-top"><div>${product.demo?'<span class="demo-tag">ВЫМЫШЛЕННЫЕ ДАННЫЕ · ТОЛЬКО ДЛЯ ЗНАКОМСТВА</span>':''}<h2>${esc(product.name)}</h2><p>${product.offers.length} карточек · цены в рублях · без скрытого объединения продавцов</p></div><button class="icon-button" id="delete-product" aria-label="Удалить товар" title="Удалить товар и его историю">×</button></div>
    <div class="discovery"><div><strong>Найти предложения</strong><small>Запустите поиск через браузер, чтобы собрать карточки в приложении. Ниже — прямые ссылки на поиск площадок.</small></div>${!product.demo?'<button class="primary" id="search-this-product">Найти карточки этого товара</button>':''}<div class="search-market-links">${searchLinks(product.name)}</div></div>
    <section class="chart-card"><div class="card-heading"><h3>Динамика итоговой стоимости</h3><div class="segments">${[7,30,0].map(n=>`<button data-period="${n}" class="${n===period?'active':''}">${n?n+' дн.':'Всё'}</button>`).join('')}</div></div><p class="chart-caption">Цена + доставка · ${esc(city)} · линии по каждой карточке</p><div id="chart"></div></section>
    <section class="offers-card"><div class="card-heading"><h3>Все предложения <span class="muted">· ${product.offers.length}</span></h3>${!product.demo?'<button class="text-button" id="add-offer">＋ Карточка по ссылке</button>':''}</div><div class="filter-bar"><label>Город <select id="city">${cities.map(c=>`<option ${c===city?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label>Площадка <select id="market"><option value="">Все</option>${Object.entries(names).map(([k,v])=>`<option value="${k}" ${market===k?'selected':''}>${v}</option>`).join('')}</select></label><label>Сначала <select id="sort">${sortOptions(sort)}</select></label></div>
    <div class="table-wrap"><table><thead><tr><th>ПЛОЩАДКА / ПРОДАВЕЦ</th><th>ИТОГО</th><th>ДОСТАВКА</th><th>РЕЙТИНГ ТОВАРА</th><th>РЕЙТИНГ ПРОДАВЦА</th><th>ОБНОВЛЕНИЕ</th><th></th></tr></thead><tbody>${offers.map(o=>{
      const h=latest(o);return `<tr data-offer-id="${o.id}"><td><span class="market-name"><i class="dot ${o.market}"></i>${names[o.market]}</span><small title="${esc(o.seller)}">${esc(o.seller)}</small></td><td><span class="price">${rub(h.price+h.shipping)}</span><small>${rub(h.price)} + ${h.shipping?rub(h.shipping):'бесплатно'}</small>${h.price+h.shipping===best?'<span class="best">↓ Лучшая цена в выборке</span>':''}</td><td><span class="delivery">${h.days_min}–${h.days_max} дн.</span><small title="${esc(h.terms)}">${esc(h.terms)}</small></td><td>${ratingText(h.product_rating)}</td><td>${ratingText(h.seller_rating)}</td><td><span title="${esc(stamp(h.at))}">${date(h.at)}</span><small>${h.source==='demo'?'Демоданные':'Вручную'}</small></td><td>${product.demo?'<span class="muted">демо</span>':`<button class="row-action" data-observe="${o.id}">＋ Цена</button> <a class="row-link" data-open-card="${o.id}" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть и собрать карточку ${esc(o.seller)}">↗</a>`}</td></tr>`;
    }).join('')||'<tr><td colspan="7">Нет наблюдений для выбранного города и площадки.</td></tr>'}</tbody></table></div><p class="table-note">Срок указан на момент наблюдения, в календарных днях. Рейтинги товара и продавца — разные показатели (0–5). Неизвестные значения всегда в конце. История сохраняется отдельно для каждого города.</p></section>
    ${!product.demo&&product.offers.length?'<section class="history-card"><h3>Журнал наблюдений</h3><div class="table-wrap"><table><thead><tr><th>ДАТА</th><th>КАРТОЧКА</th><th>ЦЕНА + ДОСТАВКА</th><th>ГОРОД / УСЛОВИЯ</th></tr></thead><tbody>'+product.offers.filter(o=>!market||o.market===market).flatMap(o=>o.history.filter(h=>h.city===city).map(h=>({o,h}))).sort((a,b)=>b.h.at.localeCompare(a.h.at)||b.h.id-a.h.id).map(({o,h})=>`<tr><td>${esc(stamp(h.at))}</td><td>${names[o.market]}<small>${esc(o.seller)}</small></td><td>${rub(h.price+h.shipping)}<small>${h.days_min}–${h.days_max} дн.</small></td><td>${esc(h.city)}<small title="${esc(h.terms)}">${esc(h.terms)}</small></td></tr>`).join('')+'</tbody></table></div></section>':''}`;
  drawChart(product);
  $('#delete-product').onclick=()=>deleteProduct(product);
  if($('#add-offer')) $('#add-offer').onclick=()=>offerForm(product);
  if($('#search-this-product')) $('#search-this-product').onclick=()=>{$('#market-query').value=product.name;startSearch(product.name,product.id);};
  $('#city').onchange=e=>{city=e.target.value;render();};
  $('#market').onchange=e=>{market=e.target.value;renderDetail();};
  $('#sort').onchange=e=>{sort=e.target.value;renderDetail();};
  document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{period=Number(b.dataset.period);renderDetail();});
  document.querySelectorAll('[data-observe]').forEach(b=>b.onclick=()=>observeForm(product.offers.find(o=>o.id===Number(b.dataset.observe))));
  document.querySelectorAll('[data-open-card]').forEach(link=>link.onclick=event=>openTrackedCard(event,link.href,product.id));
}
function drawChart(product) {
  const cutoff=period?Date.now()-period*86400000:0;
  const series=product.offers.filter(o=>!market||o.market===market).map(o=>({...o,points:o.history.filter(h=>h.city===city&&new Date(h.at).getTime()>=cutoff)})).filter(o=>o.points.length);
  if(!series.length){$('#chart').innerHTML='<div class="chart-empty">Нет наблюдений за этот период. Добавьте цену или выберите другой период.</div>';return;}
  const all=series.flatMap(o=>o.points), values=all.map(h=>h.price+h.shipping), times=all.map(h=>new Date(h.at).getTime());
  let low=Math.min(...values),high=Math.max(...values),start=Math.min(...times),end=Math.max(...times);
  const pad=Math.max((high-low)*.2,10000);low=Math.max(0,low-pad);high+=pad;
  if(start===end){start-=43200000;end+=43200000;}
  const X=h=>64+(new Date(h.at).getTime()-start)/(end-start)*590;
  const Y=h=>162-(h.price+h.shipping-low)/(high-low)*142;
  const grid=[0,1,2,3].map(i=>{const y=20+i*142/3;return `<line class="grid-line" x1="64" x2="654" y1="${y}" y2="${y}"/><text class="axis-label" x="0" y="${y+3}">${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format((high-i*(high-low)/3)/100)} ₽</text>`;}).join('');
  $('#chart').innerHTML=`<svg class="chart" viewBox="0 0 680 195" role="img" aria-label="График итоговой стоимости. Точные значения доступны в таблицах предложений и журнале.">${grid}${series.map((o,i)=>`<polyline class="chart-line" stroke="${colors[o.market]}" ${i%2?'stroke-dasharray="5 4"':''} points="${o.points.map(h=>`${X(h)},${Y(h)}`).join(' ')}"/>${o.points.map(h=>`<circle cx="${X(h)}" cy="${Y(h)}" r="3" fill="${colors[o.market]}"><title>${esc(names[o.market]+' · '+o.seller+' · '+stamp(h.at)+' · '+rub(h.price+h.shipping)+' · '+h.days_min+'–'+h.days_max+' дн.')}</title></circle>`).join('')}`).join('')}<text class="axis-label" x="64" y="188">${date(start)}</text><text class="axis-label" text-anchor="end" x="654" y="188">${date(end)}</text></svg><div class="legend">${series.map(o=>`<span><i class="dot ${o.market}"></i>${names[o.market]} · ${esc(o.seller)}</span>`).join('')}</div>`;
}
function field(name,label,value='',type='text',extra='',required=true) {return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${extra}></label>`;}
function modal(title,fields,action) {$('#modal-title').textContent=title;$('#form-fields').innerHTML=fields;$('#form-error').textContent='';submitAction=action;$('#modal').showModal();}
function newProduct() {modal('Что будем отслеживать?',field('name','Название, модель и вариант товара','','text','maxlength="200" placeholder="Например, Kiwi Ears Orchestra Lite"')+'<p class="form-help">Создам товар и запущу поиск в выбранном режиме. Для вашего окна Chrome установите расширение из папки chrome-extension.</p>',async body=>{const result=await api('/api/products',body);selected=result.id;$('#market-query').value=body.name;await startSearch(body.name,result.id);});}
function observationFields(h) {return '<div class="field-row">'+field('price','Цена товара, ₽',h?h.price/100:'','number','min="0.01" max="100000000" step="0.01"')+field('shipping','Доставка, ₽',h?h.shipping/100:0,'number','min="0" max="100000000" step="0.01"')+'</div><div class="field-row">'+field('days_min','Доставка: минимум дней',h?.days_min??1,'number','min="0" max="365" step="1"')+field('days_max','Максимум дней',h?.days_max??3,'number','min="0" max="365" step="1"')+'</div><div class="field-row">'+field('product_rating','Рейтинг товара (0–5)',h?.product_rating??'','number','min="0" max="5" step="0.01"',false)+field('seller_rating','Рейтинг продавца (0–5)',h?.seller_rating??'','number','min="0" max="5" step="0.01"',false)+'</div>'+field('city','Город доставки',city,'text','maxlength="200"')+field('terms','Условия цены / комплектация',h?.terms??'Обычная цена, без подписки','text','maxlength="500"')+'<p class="form-help">Наблюдение сохраняется с текущим временем. Неизвестный рейтинг оставьте пустым; проценты положительных отзывов не равны рейтингу 0–5. Суммы — в рублях.</p>';}
function numbers(body) {for(const key of ['days_min','days_max'])body[key]=Number(body[key]);for(const key of ['product_rating','seller_rating'])body[key]=body[key]===''?null:Number(body[key]);return body;}
function offerForm(product) {modal('Добавить карточку',field('url','Ссылка на карточку','','url','maxlength="2000" placeholder="https://…"')+field('seller','Продавец','','text','maxlength="200"')+observationFields(),body=>api(`/api/products/${product.id}/offers`,numbers(body)));}
function observeForm(offer) {modal('Новое наблюдение · '+names[offer.market],'<p class="form-help">'+esc(offer.seller)+'</p>'+observationFields(latest(offer)),body=>api(`/api/offers/${offer.id}/observations`,numbers(body)));}
function deleteProduct(product) {modal('Удалить товар?',`<p class="form-help">${esc(product.name)}<br>Будут удалены все карточки и история этого товара. Отменить удаление нельзя.</p>`,()=>api('/api/products/'+product.id,undefined,'DELETE'));}
function renderSearch() {
  const active=searchJob && !['closed','error'].includes(searchJob.status);
  $('#run-search').disabled=!!(active||searchStarting);
  if(!searchJob) return;
  $('#search-feedback').innerHTML=`<p class="search-message">${esc(searchJob.query||'')} · ${esc(searchJob.message)}</p><div class="market-statuses">${Object.entries(searchJob.markets||{}).map(([key,value])=>`<div class="source-status"><strong><i class="dot ${key}"></i> ${names[key]}</strong><span>${esc(value.message)}${value.count?' · '+value.count+' карточек':''}</span></div>`).join('')}</div>${active?`<div class="search-controls"><button class="row-action" id="collect-search">Прочитать открытые вкладки</button><button class="text-button" id="close-search">${searchJob.mode==='extension'?'Остановить сбор (вкладки останутся)':'Закрыть окно поиска'}</button></div>`:''}`;
  const scroll=$('#search-results .found-grid')?.scrollTop||0;
  const results=PriceCompare.sort(searchJob.results||[],searchSort,card=>({...card,price:card.price_minor,shipping:card.shipping_minor}));
  $('#search-results').innerHTML=results.length?`<p class="search-message">Найдено карточек: ${results.length}. Проверьте модель, город и условия скидки. Срок сортируется по верхней границе; цена с доставкой — только при известной стоимости доставки. Неизвестные значения в конце.</p><div class="found-grid">${results.map((card,i)=>`<article class="found-card" data-result-url="${esc(card.url)}"><div class="market-name"><i class="dot ${card.market}"></i>${names[card.market]}</div><h3>${esc(card.title)}</h3><strong>${esc(card.price_text||'Цена не прочитана')}</strong><p>${esc(card.delivery_text||'Срок и стоимость доставки не прочитаны')}</p><small>${esc(card.seller||'Продавец не указан в выдаче')}</small><p class="found-ratings">Товар: ${ratingText(card.product_rating)}<br>Продавец: ${ratingText(card.seller_rating)}</p><div><a data-found-open="${i}" target="_blank" rel="noopener noreferrer" href="${esc(card.url)}">Открыть и собрать</a><button class="row-action" data-import-result="${i}">Добавить в сравнение</button></div></article>`).join('')}</div>`:'';
  if($('#search-results .found-grid'))$('#search-results .found-grid').scrollTop=scroll;
  if($('#collect-search')) $('#collect-search').onclick=()=>searchCommand('collect');
  if($('#close-search')) $('#close-search').onclick=()=>searchCommand('close');
  document.querySelectorAll('[data-import-result]').forEach(b=>b.onclick=()=>importResult(results[Number(b.dataset.importResult)]));
  document.querySelectorAll('[data-found-open]').forEach(link=>link.onclick=event=>openTrackedCard(event,link.href,searchProductId));
}
async function startSearch(query,productId,initialUrl=null) {
  if(searchStarting) return;
  searchStarting=true;clearTimeout(searchTimer);$('#run-search').disabled=true;
  let startedId=null;
  const mode=$('#search-mode').value;
  try {
    if(mode==='extension')await extensionRequest('ping');
    const host=initialUrl?new URL(initialUrl).hostname:'';
    const onlyMarket=host.includes('ozon.ru')?'ozon':host.includes('wildberries.ru')?'wb':host.includes('aliexpress.')?'ali':'yandex';
    const result=await api('/api/search',{query,mode,markets:initialUrl?[onlyMarket]:null});startedId=result.id;
    searchProductId=productId;
    searchJob={id:result.id,query,mode,status:'starting',message:mode==='extension'?'Открываю вкладки в вашем окне Chrome…':'Открываю отдельный браузер…',markets:{},results:[]};
    if(mode==='extension')await extensionRequest('start',{jobId:result.id,query,url:initialUrl},15000);
    renderSearch();await pollSearch();
  } catch(e) {
    if(startedId){
      if(mode==='extension'){try{await extensionRequest('stop',{jobId:startedId});}catch{}}
      try{await api('/api/search/'+startedId+'/close',{});}catch{}
      searchJob.status='error';searchJob.message=e.message;renderSearch();
    }
    $('#search-feedback').textContent=e.message;
    if(searchJob && !['closed','error'].includes(searchJob.status)) searchTimer=setTimeout(pollSearch,2000);
  } finally {searchStarting=false;$('#run-search').disabled=!!(searchJob&&!['closed','error'].includes(searchJob.status));}
}
async function pollSearch() {
  if(!searchJob?.id) return;
  const jobId=searchJob.id;
  try {
    const response=await fetch('/api/search/'+encodeURIComponent(jobId));
    if(!response.ok) throw new Error('Поиск недоступен. Перезагрузите страницу и запустите заново.');
    const data=await response.json();
    if(searchJob?.id!==jobId) return;
    if(JSON.stringify(searchJob)!==JSON.stringify(data)){searchJob=data;renderSearch();}
    if(!['closed','error'].includes(data.status)) searchTimer=setTimeout(pollSearch,2500);
  } catch(e) {$('#search-feedback').textContent=e.message;$('#run-search').disabled=false;}
}
async function searchCommand(action) {
  try {
    if(searchJob.mode==='extension'){
      try{await extensionRequest(action==='close'?'stop':'collect',{jobId:searchJob.id},10000);}
      finally{await api('/api/search/'+searchJob.id+'/'+action,{});}
    }else await api('/api/search/'+searchJob.id+'/'+action,{});
    toast(action==='close'?(searchJob.mode==='extension'?'Сбор остановлен. Вкладки открыты.':'Закрываю окно поиска…'):'Читаю открытые вкладки…');
  }catch(e){toast(e.message);}
}
async function importResult(card) {
  try {
    let product=state.products.find(p=>p.id===searchProductId && !p.demo);
    if(!product){const result=await api('/api/products',{name:searchJob.query});searchProductId=result.id;selected=result.id;await refresh();product=state.products.find(p=>p.id===result.id);}
    const existing=product.offers.find(o=>cardIdentity(o.url)===cardIdentity(card.url));
    modal(existing?'Новое наблюдение из карточки':'Проверьте карточку перед сохранением',`<p class="form-help">${esc(card.title)}<br>Показанная цена: ${esc(card.price_text||'не прочитана')}. Проверьте вариант, скидки, рейтинги и доставку для ${esc(city)}. Прочитанные поля подставлены, неизвестные остаются пустыми.</p>`+field('url','Карточка',card.url,'url','maxlength="2000" readonly')+field('seller','Продавец',existing?.seller||card.seller||'Не указан в выдаче','text','maxlength="200" '+(existing?'readonly':''))+observationFields(),body=>api(existing?`/api/offers/${existing.id}/observations`:`/api/products/${product.id}/offers`,numbers(body)));
    $('#edit-form [name=price]').value=typeof card.price_minor==='number'?card.price_minor/100:'';
    selected=product.id;
    // Preserve unknown values; zero delivery cost is valid only when read explicitly.
    $('#edit-form [name=shipping]').value=typeof card.shipping_minor==='number'?card.shipping_minor/100:'';
    for(const name of ['days_min','days_max','product_rating','seller_rating']) $(`#edit-form [name=${name}]`).value=card[name]??'';
    $('#edit-form [name=terms]').value='';
  }catch(e){toast(e.message);}
}
$('#market-search-form').onsubmit=async e=>{
  e.preventDefault();
  const query=$('#market-query').value.trim();
  if(!query)return;
  try {const result=await api('/api/products',{name:query});selected=result.id;await refresh();await startSearch(query,result.id);}catch(error){toast(error.message);}
};
$('#new-product').onclick=newProduct;
$('#search-sort').innerHTML=sortOptions(searchSort);
$('#search-sort').onchange=e=>{searchSort=e.target.value;renderSearch();};
$('#check-extension').onclick=checkExtension;
setTimeout(checkExtension,500);
$('#close-modal').onclick=()=>$('#modal').close();
$('#search').oninput=e=>{filter=e.target.value;render();};
$('#demo').onclick=async()=>{try{await api('/api/demo',{});await refresh();const p=state.products.find(p=>p.demo);selected=p.id;render();}catch(e){toast(e.message);}};
$('#edit-form').onsubmit=async e=>{e.preventDefault();$('#save-button').disabled=true;$('#form-error').textContent='';try{await submitAction(Object.fromEntries(new FormData(e.target)));$('#modal').close();await refresh();toast('Сохранено');}catch(error){$('#form-error').textContent=error.message;}finally{$('#save-button').disabled=false;}};
refresh().then(async()=>{const response=await fetch('/api/search/current');if(response.ok){searchJob=await response.json();searchProductId=state.products.find(p=>p.name===searchJob.query&&!p.demo)?.id;$('#market-query').value=searchJob.query;$('#search-mode').value=searchJob.mode||'browser';renderSearch();if(!['closed','error'].includes(searchJob.status))pollSearch();}}).catch(e=>{$('#detail').innerHTML='<div class="empty"><strong>Не удалось загрузить данные</strong>Проверьте, запущен ли сервер, и перезагрузите страницу.</div>';toast(e.message);});
