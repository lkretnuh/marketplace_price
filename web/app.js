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
  let offers=product.offers.filter(o=>(!market||o.market===market)&&latest(o));
  offers.sort((a,b)=>{const x=latest(a),y=latest(b);return sort==='days'?x.days_max-y.days_max:(x.price+x.shipping)-(y.price+y.shipping);});
  const best=offers.length?Math.min(...offers.map(o=>latest(o).price+latest(o).shipping)):null;
  $('#detail').innerHTML=`<div class="detail-top"><div>${product.demo?'<span class="demo-tag">ВЫМЫШЛЕННЫЕ ДАННЫЕ · ТОЛЬКО ДЛЯ ЗНАКОМСТВА</span>':''}<h2>${esc(product.name)}</h2><p>${product.offers.length} карточек · цены в рублях · без скрытого объединения продавцов</p></div><button class="icon-button" id="delete-product" aria-label="Удалить товар" title="Удалить товар и его историю">×</button></div>
    <div class="discovery"><div><strong>Найти предложения</strong><small>Поиск откроется на сайте площадки. Единой выдачи в приложении пока нет.</small></div><div class="search-market-links">${searchLinks(product.name)}</div></div>
    <section class="chart-card"><div class="card-heading"><h3>Динамика итоговой стоимости</h3><div class="segments">${[7,30,0].map(n=>`<button data-period="${n}" class="${n===period?'active':''}">${n?n+' дн.':'Всё'}</button>`).join('')}</div></div><p class="chart-caption">Цена + доставка · ${esc(city)} · линии по каждой карточке</p><div id="chart"></div></section>
    <section class="offers-card"><div class="card-heading"><h3>Все предложения <span class="muted">· ${product.offers.length}</span></h3>${!product.demo?'<button class="text-button" id="add-offer">＋ Карточка по ссылке</button>':''}</div><div class="filter-bar"><label>Город <select id="city">${cities.map(c=>`<option ${c===city?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label>Площадка <select id="market"><option value="">Все</option>${Object.entries(names).map(([k,v])=>`<option value="${k}" ${market===k?'selected':''}>${v}</option>`).join('')}</select></label><label>Сначала <select id="sort"><option value="total" ${sort==='total'?'selected':''}>Дешевле с доставкой</option><option value="days" ${sort==='days'?'selected':''}>Быстрее доставка</option></select></label></div>
    <div class="table-wrap"><table><thead><tr><th>ПЛОЩАДКА / ПРОДАВЕЦ</th><th>ИТОГО</th><th>ДОСТАВКА</th><th>ОБНОВЛЕНИЕ</th><th></th></tr></thead><tbody>${offers.map(o=>{
      const h=latest(o);return `<tr><td><span class="market-name"><i class="dot ${o.market}"></i>${names[o.market]}</span><small title="${esc(o.seller)}">${esc(o.seller)}</small></td><td><span class="price">${rub(h.price+h.shipping)}</span><small>${rub(h.price)} + ${h.shipping?rub(h.shipping):'бесплатно'}</small>${h.price+h.shipping===best?'<span class="best">↓ Лучшая цена в выборке</span>':''}</td><td><span class="delivery">${h.days_min}–${h.days_max} дн.</span><small title="${esc(h.terms)}">${esc(h.terms)}</small></td><td><span title="${esc(stamp(h.at))}">${date(h.at)}</span><small>${h.source==='demo'?'Демоданные':'Вручную'}</small></td><td>${product.demo?'<span class="muted">демо</span>':`<button class="row-action" data-observe="${o.id}">＋ Цена</button> <a class="row-link" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть карточку ${esc(o.seller)}">↗</a>`}</td></tr>`;
    }).join('')||'<tr><td colspan="5">Нет наблюдений для выбранного города и площадки.</td></tr>'}</tbody></table></div><p class="table-note">Срок указан на момент наблюдения, в календарных днях. Сравнивайте одинаковые варианты товара и условия скидок. История сохраняется отдельно для каждого города.</p></section>
    ${!product.demo&&product.offers.length?'<section class="history-card"><h3>Журнал наблюдений</h3><div class="table-wrap"><table><thead><tr><th>ДАТА</th><th>КАРТОЧКА</th><th>ЦЕНА + ДОСТАВКА</th><th>ГОРОД / УСЛОВИЯ</th></tr></thead><tbody>'+product.offers.filter(o=>!market||o.market===market).flatMap(o=>o.history.filter(h=>h.city===city).map(h=>({o,h}))).sort((a,b)=>b.h.at.localeCompare(a.h.at)||b.h.id-a.h.id).map(({o,h})=>`<tr><td>${esc(stamp(h.at))}</td><td>${names[o.market]}<small>${esc(o.seller)}</small></td><td>${rub(h.price+h.shipping)}<small>${h.days_min}–${h.days_max} дн.</small></td><td>${esc(h.city)}<small title="${esc(h.terms)}">${esc(h.terms)}</small></td></tr>`).join('')+'</tbody></table></div></section>':''}`;
  drawChart(product);
  $('#delete-product').onclick=()=>deleteProduct(product);
  if($('#add-offer')) $('#add-offer').onclick=()=>offerForm(product);
  $('#city').onchange=e=>{city=e.target.value;render();};
  $('#market').onchange=e=>{market=e.target.value;renderDetail();};
  $('#sort').onchange=e=>{sort=e.target.value;renderDetail();};
  document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{period=Number(b.dataset.period);renderDetail();});
  document.querySelectorAll('[data-observe]').forEach(b=>b.onclick=()=>observeForm(product.offers.find(o=>o.id===Number(b.dataset.observe))));
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
function field(name,label,value='',type='text',extra='') {return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" required ${extra}></label>`;}
function modal(title,fields,action) {$('#modal-title').textContent=title;$('#form-fields').innerHTML=fields;$('#form-error').textContent='';submitAction=action;$('#modal').showModal();}
function newProduct() {modal('Что будем отслеживать?',field('name','Название, модель и вариант товара','','text','maxlength="200" placeholder="Например, iPhone 16 128 ГБ, чёрный"')+'<p class="form-help">Название создаёт группу для сравнения. После сохранения можно открыть поиск на четырёх площадках и добавить подходящие карточки. Единой поисковой выдачи и автоматического сопоставления пока нет.</p>',async body=>{const result=await api('/api/products',body);selected=result.id;});}
function observationFields(h) {return '<div class="field-row">'+field('price','Цена товара, ₽',h?h.price/100:'','number','min="0.01" max="100000000" step="0.01"')+field('shipping','Доставка, ₽',h?h.shipping/100:0,'number','min="0" max="100000000" step="0.01"')+'</div><div class="field-row">'+field('days_min','Доставка: минимум дней',h?.days_min??1,'number','min="0" max="365" step="1"')+field('days_max','Максимум дней',h?.days_max??3,'number','min="0" max="365" step="1"')+'</div>'+field('city','Город доставки',city,'text','maxlength="200"')+field('terms','Условия цены / комплектация',h?.terms??'Обычная цена, без подписки','text','maxlength="500"')+'<p class="form-help">Наблюдение будет сохранено с текущим временем. Укажите цену для своей комплектации, способа оплаты и города. Все суммы — в рублях.</p>';}
function numbers(body) {for(const key of ['days_min','days_max'])body[key]=Number(body[key]);return body;}
function offerForm(product) {modal('Добавить карточку',field('url','Ссылка на карточку','','url','maxlength="2000" placeholder="https://…"')+field('seller','Продавец','','text','maxlength="200"')+observationFields(),body=>api(`/api/products/${product.id}/offers`,numbers(body)));}
function observeForm(offer) {modal('Новое наблюдение · '+names[offer.market],'<p class="form-help">'+esc(offer.seller)+'</p>'+observationFields(latest(offer)),body=>api(`/api/offers/${offer.id}/observations`,numbers(body)));}
function deleteProduct(product) {modal('Удалить товар?',`<p class="form-help">${esc(product.name)}<br>Будут удалены все карточки и история этого товара. Отменить удаление нельзя.</p>`,()=>api('/api/products/'+product.id,undefined,'DELETE'));}
$('#new-product').onclick=newProduct;
$('#close-modal').onclick=()=>$('#modal').close();
$('#search').oninput=e=>{filter=e.target.value;render();};
$('#demo').onclick=async()=>{try{await api('/api/demo',{});await refresh();const p=state.products.find(p=>p.demo);selected=p.id;render();}catch(e){toast(e.message);}};
$('#edit-form').onsubmit=async e=>{e.preventDefault();$('#save-button').disabled=true;$('#form-error').textContent='';try{await submitAction(Object.fromEntries(new FormData(e.target)));$('#modal').close();await refresh();toast('Сохранено');}catch(error){$('#form-error').textContent=error.message;}finally{$('#save-button').disabled=false;}};
refresh().catch(e=>{$('#detail').innerHTML='<div class="empty"><strong>Не удалось загрузить данные</strong>Проверьте, запущен ли сервер, и перезагрузите страницу.</div>';toast(e.message);});
