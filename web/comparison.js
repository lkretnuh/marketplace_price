/* Shared comparison for saved observations and search candidates. */
(() => {
  const options=[['price','Цена товара: дешевле'],['price_desc','Цена товара: дороже'],
    ['total','С доставкой: дешевле'],['total_desc','С доставкой: дороже'],
    ['days','Доставка: быстрее'],['product_rating','Рейтинг товара: выше'],['seller_rating','Рейтинг продавца: выше']];
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  function value(row,key){
    if(key==='total'||key==='total_desc')return number(row.price)!==null&&number(row.shipping)!==null?row.price+row.shipping:null;
    if(key==='price'||key==='price_desc')return number(row.price);
    if(key==='days')return number(row.days_max);
    return number(row[key]);
  }
  function sort(rows,key,getRow=row=>row){
    if(!options.some(option=>option[0]===key))key='price';
    const descending=['price_desc','total_desc','product_rating','seller_rating'].includes(key);
    return rows.map((row,index)=>({row,index,val:value(getRow(row),key)})).sort((a,b)=>{
      if(a.val===null)return b.val===null?a.index-b.index:1;
      if(b.val===null)return -1;
      return (descending?b.val-a.val:a.val-b.val)||a.index-b.index;
    }).map(item=>item.row);
  }
  const api={sort,options};
  globalThis.PriceCompare=api;
  if(typeof module!=='undefined')module.exports=api;
})();
