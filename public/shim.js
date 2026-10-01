// 预览沙箱桥：生成的应用运行在无同源权限的 sandbox iframe 中（无法读取宿主登录态），
// 但这种环境下原生 localStorage 不可用。这里注入一个兼容的 Storage 实现：
//  - 预览模式：数据通过 postMessage 回传宿主，由宿主按“项目”持久化 → 刷新后仍在；
//  - 分享页：退化为内存存储（下载导出的独立 HTML 则使用真实 localStorage）。
// 同时把运行时错误回传宿主，用于“一键让 AI 修复”。
// 本文件同时被浏览器（ES Module）和 Worker（打包）引用。

export function buildShim({ storageKey = 'atoms', initial = {}, bridge = true } = {}) {
  const init = JSON.stringify(initial || {}).replace(/</g, '\\u003c');
  const key = JSON.stringify(String(storageKey)).replace(/</g, '\\u003c');
  return `<script data-atoms-shim>(function(){
var KEY=${key},BRIDGE=${bridge ? 'true' : 'false'},data=${init},sdata={};
function post(m){try{parent&&parent!==window&&parent.postMessage(m,'*')}catch(e){}}
function mk(store,persist){var has=function(k){return Object.prototype.hasOwnProperty.call(store(),k)};
var api={getItem:function(k){k=String(k);return has(k)?store()[k]:null},setItem:function(k,v){store()[String(k)]=String(v);persist()},
removeItem:function(k){delete store()[String(k)];persist()},clear:function(){var s=store();Object.keys(s).forEach(function(k){delete s[k]});persist()},
key:function(i){return Object.keys(store())[i]||null}};
return new Proxy(api,{get:function(t,p){if(p==='length')return Object.keys(store()).length;if(p in t)return t[p];return typeof p==='string'&&has(p)?store()[p]:undefined},
set:function(t,p,v){api.setItem(p,v);return true},deleteProperty:function(t,p){api.removeItem(p);return true},
has:function(t,p){return p in t||has(p)},ownKeys:function(){return Object.keys(store())},
getOwnPropertyDescriptor:function(t,p){if(has(p))return{value:store()[p],enumerable:true,configurable:true,writable:true}}})}
var ok=false;try{window.localStorage.setItem('__atoms_t','1');window.localStorage.removeItem('__atoms_t');ok=true}catch(e){}
if(!ok){var ls=mk(function(){return data},function(){if(BRIDGE)post({__atoms:'ls',key:KEY,data:data})});
var ss=mk(function(){return sdata},function(){});
try{Object.defineProperty(window,'localStorage',{value:ls,configurable:true})}catch(e){}
try{Object.defineProperty(window,'sessionStorage',{value:ss,configurable:true})}catch(e){}}
window.addEventListener('error',function(e){post({__atoms:'error',message:String(e.message||'Error'),line:e.lineno||0,col:e.colno||0})});
window.addEventListener('unhandledrejection',function(e){post({__atoms:'error',message:'Unhandled promise rejection: '+String(e.reason&&e.reason.message||e.reason)})});
})();<\/script>`;
}

export function injectShim(html, opts) {
  const shim = buildShim(opts);
  const src = String(html || '');
  const m = src.match(/<head[^>]*>/i);
  if (m) return src.replace(m[0], m[0] + shim);
  const h = src.match(/<html[^>]*>/i);
  if (h) return src.replace(h[0], h[0] + '<head>' + shim + '</head>');
  return shim + src;
}
