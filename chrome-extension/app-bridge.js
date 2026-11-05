(() => {
  if(location.pathname !== '/' || globalThis.tsenoskopAppBridge) return;
  globalThis.tsenoskopAppBridge=true;
  const allowed=new Set(['ping','start','collect','stop','open-card']);
  window.addEventListener('message',async event=>{
    if(event.source!==window || event.origin!==location.origin || event.data?.source!=='tsenoskop-app')return;
    const {id,action,payload}=event.data;
    if(typeof id!=='string'||id.length>100||!allowed.has(action))return;
    let response;
    try{response=await chrome.runtime.sendMessage({channel:'tsenoskop',action,payload});}
    catch{response={ok:false,error:'Расширение обновлено или отключено. Обновите страницу Ценоскопа (Ctrl+F5).'};}
    window.postMessage({source:'tsenoskop-extension',id,response},location.origin);
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.channel==='tsenoskop-result'){
      window.postMessage({source:'tsenoskop-extension',result:message},location.origin);
      if(typeof respond==='function')respond({ok:true});
    }
  });
})();
