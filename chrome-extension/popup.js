document.querySelector('#capture').onclick=async()=>{
  const button=document.querySelector('#capture');button.disabled=true;
  try{
    const answer=await chrome.runtime.sendMessage({channel:'tsenoskop',action:'capture-current'});
    document.querySelector('#status').textContent=answer?.ok?'Данные отправлены в Ценоскоп. Сбор продолжится до остановки поиска.':answer?.error||'Не удалось прочитать вкладку';
  }catch{document.querySelector('#status').textContent='Расширение недоступно. Перезагрузите его и страницу Ценоскопа.';}
  finally{button.disabled=false;}
};
