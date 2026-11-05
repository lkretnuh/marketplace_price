// Executes the actual MV3 worker against a mocked Chrome API. No extension
// installation or live network is involved in this contract test.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const manifest=require('../chrome-extension/manifest.json');
const clone=value=>JSON.parse(JSON.stringify(value));
let storage={},next=10,activeTab=2;
const tabs=new Map([[1,{id:1,windowId:7,url:'http://localhost:8000/'}],
  [2,{id:2,windowId:7,url:'https://www.ozon.ru/product/existing/'}],
  [3,{id:3,windowId:9,url:'https://www.ozon.ru/product/existing/'}]]);
const created=[],updated=[],forwarded=[];
const chrome={
  runtime:{id:'test-extension',getManifest:()=>manifest,getURL:path=>'chrome-extension://test-extension/'+path,onMessage:{addListener() {}}},
  storage:{session:{get:async key=>({[key]:clone(storage[key]||{})}),set:async value=>Object.assign(storage,clone(value))}},
  scripting:{executeScript:async()=>{}},
  tabs:{
    create:async options=>{const tab={...options,id:next++};tabs.set(tab.id,tab);created.push(tab);return tab;},
    update:async(id,options)=>{Object.assign(tabs.get(id),options);updated.push(id);return tabs.get(id);},
    get:async id=>tabs.get(id),
    query:async options=>[...tabs.values()].filter(tab=>(options.windowId===undefined||tab.windowId===options.windowId)&&(!options.active||tab.id===activeTab)),
    sendMessage:async(id,message)=>{
      if(message.channel==='tsenoskop-result'){forwarded.push({id,message});return {};}
      return {ok:true,extracted:{cards:[]}};
    },
    onUpdated:{addListener(){}},onRemoved:{addListener(){}},
  },
};
const context=vm.createContext({chrome,URL,console,Promise,Error,Object,String,Number});
vm.runInContext(fs.readFileSync(require.resolve('../chrome-extension/background.js'),'utf8'),context);
const app={id:chrome.runtime.id,frameId:0,url:'http://localhost:8000/',tab:{id:1,windowId:7}};
const call=(action,payload={},sender=app)=>context.handle({channel:'tsenoskop',action,payload},sender);
async function main(){
  assert(!manifest.permissions.includes('cookies'));
  assert(!manifest.host_permissions.includes('<all_urls>'));
  await assert.rejects(()=>call('start',{jobId:'a'.repeat(32),query:'Kiwi'},{...app,url:'https://evil.test/'}));
  await assert.rejects(()=>call('start',{jobId:'a'.repeat(32),query:'Kiwi'},{...app,frameId:1}));
  await assert.rejects(()=>call('ping',{}, {...app,id:'different-extension'}));
  await call('start',{jobId:'a'.repeat(32),query:'Kiwi Ears Orchestra Lite'});
  assert.equal(created.length,4);
  assert(created.every(tab=>tab.windowId===7&&tab.active===false));
  assert.equal(new URL(created[0].url).searchParams.get('text'),'Kiwi Ears Orchestra Lite');
  const count=tabs.size;
  await call('open-card',{jobId:'a'.repeat(32),url:'https://www.ozon.ru/product/existing/'});
  assert.equal(tabs.size,count);
  assert(updated.includes(2));
  assert(!updated.includes(3)); // matching card in another window must not steal focus
  await assert.rejects(()=>call('open-card',{jobId:'a'.repeat(32),url:'https://evil.test/product/123'}));
  await context.handle({channel:'tsenoskop',action:'capture-current'}, {id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')});
  assert(storage.sessions['1'].tabs['2']);
  assert(forwarded.some(entry=>entry.id===1&&entry.message.jobId==='a'.repeat(32)));
  await call('stop',{jobId:'a'.repeat(32)});
  assert.equal(tabs.size,count); // stopping collection must not close user tabs
  assert.deepEqual(storage.sessions,{});
  await assert.rejects(()=>context.handle({channel:'tsenoskop',action:'market-data',jobId:'a'.repeat(32),extracted:{cards:[]}},
    {id:chrome.runtime.id,frameId:0,url:tabs.get(2).url,tab:tabs.get(2)}));
  console.log('PASS: MV3 worker contract: same windowId, existing-tab reuse, attach-current-tab, no closed tabs, stale jobs and invalid senders/URLs rejected; mocked Chrome API');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
