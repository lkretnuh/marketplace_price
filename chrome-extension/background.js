'use strict';
const hosts={ozon:['ozon.ru','www.ozon.ru'],wb:['wildberries.ru','www.wildberries.ru'],
  yandex:['market.yandex.ru','www.market.yandex.ru'],ali:['aliexpress.ru','www.aliexpress.ru','aliexpress.com','www.aliexpress.com']};
const urls={ozon:'https://www.ozon.ru/search/?text=',wb:'https://www.wildberries.ru/catalog/0/search.aspx?search=',
  yandex:'https://market.yandex.ru/search?text=',ali:'https://aliexpress.ru/wholesale?SearchText='};
const productPaths={ozon:/\/product\/[^/?#]+/,wb:/\/catalog\/\d+\/detail\.aspx/,yandex:/\/(?:product--[^/]+|card|offer)\//,ali:/\/item\/[^/?#]+/};
let writing=Promise.resolve();
async function sessions(){return (await chrome.storage.session.get('sessions')).sessions||{};}
function change(mutator){
  const work=writing.then(async()=>{const all=await sessions();const result=await mutator(all);await chrome.storage.session.set({sessions:all});return result;});
  writing=work.catch(()=>{});return work;
}
function marketOf(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;
    return Object.keys(hosts).find(key=>hosts[key].includes(url.hostname))||null;
  }catch{return null;}
}
function isApp(sender){
  if(!sender.tab?.id || sender.frameId!==0)return false;
  try{const url=new URL(sender.url);return url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/';}catch{return false;}
}
function sameCard(value){
  const url=new URL(value);url.hash='';for(const key of [...url.searchParams.keys()])if(/^(utm_|from$|sh$|oos_search$)/i.test(key))url.searchParams.delete(key);return url.href;
}
async function findTab(tabId){
  const all=await sessions();return Object.values(all).find(session=>session.tabs[String(tabId)]);
}
async function forward(session,tabId,extracted){
  const current=(await sessions())[String(session.appTabId)];
  if(!current||current.jobId!==session.jobId||!current.tabs[String(tabId)])return;
  await chrome.tabs.sendMessage(session.appTabId,{channel:'tsenoskop-result',jobId:session.jobId,
    market:current.tabs[String(tabId)].market,extracted});
}
async function collectOne(session,tabId){
  const tab=await chrome.tabs.get(Number(tabId));
  const entry=session.tabs[String(tabId)];
  if(!entry)return;
  if(marketOf(tab.url)!==entry.market){await forward(session,tabId,{cards:[],error:true});return;}
  const request={channel:'tsenoskop-collector',action:'collect',jobId:session.jobId,market:entry.market};
  let response;
  try{response=await chrome.tabs.sendMessage(Number(tabId),request);}
  catch{
    // Also supports tabs that were open before the extension was installed.
    await chrome.scripting.executeScript({target:{tabId:Number(tabId)},files:['extract.js','market.js']});
    response=await chrome.tabs.sendMessage(Number(tabId),request);
  }
  if(response?.ok)await forward(session,tabId,response.extracted);
}
async function collectAll(session){
  await Promise.allSettled(Object.keys(session.tabs).map(id=>collectOne(session,Number(id)).catch(()=>forward(session,id,{cards:[],error:true}))));
}
async function stopSession(session){
  await change(all=>{if(all[String(session.appTabId)]?.jobId===session.jobId)delete all[String(session.appTabId)];});
  await Promise.allSettled(Object.keys(session.tabs).map(id=>chrome.tabs.sendMessage(Number(id),{channel:'tsenoskop-collector',action:'stop',jobId:session.jobId})));
}
async function appAction(action,payload,sender){
  const key=String(sender.tab.id);
  if(action==='ping')return {version:chrome.runtime.getManifest().version};
  if(action==='start'){
    if(!/^[a-f0-9]{32}$/.test(payload?.jobId)||typeof payload.query!=='string'||!payload.query.trim()||payload.query.length>200)throw Error('Неверный запрос поиска');
    const singleMarket=payload.url?marketOf(payload.url):null;
    if(payload.url&&(!singleMarket||!productPaths[singleMarket].test(new URL(payload.url).pathname)))throw Error('Неверная ссылка на карточку');
    const current=await sessions();
    if(Object.values(current).some(s=>s.windowId===sender.tab.windowId&&s.appTabId!==sender.tab.id))throw Error('В этом окне уже собирает данные другая вкладка Ценоскопа. Остановите тот поиск.');
    const previous=current[key];if(previous)await stopSession(previous);
    const session=await change(async all=>{
      const session={appTabId:sender.tab.id,windowId:sender.tab.windowId,jobId:payload.jobId,tabs:{}};
      const targets=payload.url?[[singleMarket,payload.url]]:Object.entries(urls).map(([market,base])=>[market,base+encodeURIComponent(payload.query)]);
      for(const [market,url] of targets){
        const existing=payload.url?(await chrome.tabs.query({windowId:session.windowId})).find(tab=>marketOf(tab.url)===market&&sameCard(tab.url)===sameCard(url)):null;
        const tab=existing?await chrome.tabs.update(existing.id,{active:true}):await chrome.tabs.create({windowId:session.windowId,url,active:!!payload.url});
        session.tabs[String(tab.id)]={market};
      }
      all[key]=session;return session;
    });
    collectAll(session).catch(()=>{});return {opened:Object.keys(session.tabs).length};
  }
  const session=(await sessions())[key];
  if(!session||session.jobId!==payload?.jobId)throw Error('Сначала запустите поиск через Ценоскоп в этом окне');
  if(action==='collect'){collectAll(session).catch(()=>{});return {};}
  if(action==='stop'){await stopSession(session);return {};}
  if(action==='open-card'){
    const market=marketOf(payload.url);
    if(!market||!productPaths[market].test(new URL(payload.url).pathname))throw Error('Нужна карточка поддерживаемого маркетплейса');
    const existing=(await chrome.tabs.query({windowId:session.windowId})).find(tab=>marketOf(tab.url)===market&&sameCard(tab.url)===sameCard(payload.url));
    const tab=existing?await chrome.tabs.update(existing.id,{active:true}):await chrome.tabs.create({windowId:session.windowId,url:payload.url,active:true});
    const updated=await change(all=>{if(all[key]?.jobId!==session.jobId)throw Error('Поиск остановлен');all[key].tabs[String(tab.id)]={market};return all[key];});
    collectOne(updated,tab.id).catch(()=>{});return {};
  }
  throw Error('Неизвестное действие');
}
async function handle(message,sender){
  if(sender.id!==chrome.runtime.id||message?.channel!=='tsenoskop')throw Error('Недопустимый отправитель');
  if(isApp(sender))return appAction(message.action,message.payload,sender);
  if(message.action==='capture-current'&&sender.url===chrome.runtime.getURL('popup.html')){
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const market=marketOf(tab?.url);
    if(!market)throw Error('Откройте карточку или выдачу маркетплейса в активной вкладке');
    const candidates=Object.values(await sessions()).filter(s=>s.windowId===tab.windowId);
    if(candidates.length!==1)throw Error('Сначала запустите один поиск в Ценоскопе в этом же окне');
    const session=await change(all=>{const key=String(candidates[0].appTabId);all[key].tabs[String(tab.id)]={market};return all[key];});
    await collectOne(session,tab.id);return {};
  }
  if(sender.frameId!==0||!sender.tab?.id)throw Error('Недопустимая вкладка');
  const session=await findTab(sender.tab.id);
  if(!session||marketOf(sender.url)!==session.tabs[String(sender.tab.id)].market)throw Error('Сбор в этой вкладке не включён');
  if(message.action==='market-ready'){collectOne(session,sender.tab.id).catch(()=>{});return {};}
  if(message.action==='market-data'&&message.jobId===session.jobId){await forward(session,sender.tab.id,message.extracted);return {};}
  throw Error('Неизвестное действие');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  handle(message,sender).then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message}));return true;
});
chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(changeInfo.status==='complete')findTab(tabId).then(session=>{if(session)return collectOne(session,tabId);}).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(tabId=>{
  sessions().then(async all=>{
    if(all[String(tabId)])await stopSession(all[String(tabId)]);
    else await change(current=>{for(const session of Object.values(current))delete session.tabs[String(tabId)];});
  }).catch(()=>{});
});
