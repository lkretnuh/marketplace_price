(() => {
  if(globalThis.tsenoskopMarketLoaded)return;
  globalThis.tsenoskopMarketLoaded=true;
  let lease=null,timer=null;
  const extract=()=>globalThis.TsenoskopExtract(lease.market);
  const stop=()=>{lease=null;clearInterval(timer);timer=null;};
  const publish=async()=>{
    if(!lease)return;
    try{
      const answer=await chrome.runtime.sendMessage({channel:'tsenoskop',action:'market-data',jobId:lease.jobId,extracted:extract()});
      if(!answer?.ok)stop();
    }catch{stop();}
  };
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(message?.channel!=='tsenoskop-collector')return;
    if(message.action==='stop'){if(!message.jobId||lease?.jobId===message.jobId)stop();sendResponse({ok:true});return;}
    if(message.action==='collect'){
      lease={market:message.market,jobId:message.jobId};
      if(!timer)timer=setInterval(publish,8000);
      try{sendResponse({ok:true,extracted:extract()});}catch{sendResponse({ok:false});}
    }
  });
  chrome.runtime.sendMessage({channel:'tsenoskop',action:'market-ready'}).catch(()=>{});
})();
