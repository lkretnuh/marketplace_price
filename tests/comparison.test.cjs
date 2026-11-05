const assert=require('node:assert/strict');
const {sort}=require('../web/comparison.js');
const rows=[
  {id:'a',price:100,shipping:100,days_max:5,product_rating:4.9,seller_rating:null},
  {id:'b',price:150,shipping:0,days_max:1,product_rating:4.5,seller_rating:4.9},
  {id:'c',price:null,shipping:null,days_max:null,product_rating:null,seller_rating:4.1},
  {id:'d',price:100,shipping:null,days_max:3,product_rating:0,seller_rating:0},
];
const ids=key=>sort(rows,key).map(row=>row.id);
assert.deepEqual(ids('price'),['a','d','b','c']);
assert.deepEqual(ids('price_desc'),['b','a','d','c']);
assert.deepEqual(ids('total'),['b','a','c','d']);
assert.deepEqual(ids('total_desc'),['a','b','c','d']);
assert.deepEqual(ids('days'),['b','d','a','c']);
assert.deepEqual(ids('product_rating'),['a','b','d','c']);
assert.deepEqual(ids('seller_rating'),['b','c','d','a']);
assert.deepEqual(rows.map(row=>row.id),['a','b','c','d']);
console.log('PASS: 7 comparison modes, unknowns last, zero rating, ties, no input mutation');
