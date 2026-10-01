// 预览沙箱桥：生成的应用运行在无同源权限的 sandbox iframe 中（无法读取宿主登录态），
// 但这种环境下原生 localStorage 不可用。这里注入一个兼容的 Storage 实现：
//  - 预览模式：数据通过 postMessage 回传宿主，由宿主按“项目”持久化 → 刷新后仍在；
//  - 分享页：退化为内存存储（下载导出的独立 HTML 则使用真实 localStorage）。
// 同时把运行时错误回传宿主，用于“一键让 AI 修复”。
// 本文件同时被浏览器（ES Module）和 Worker（打包）引用。

export function buildShim({ storageKey = 'atoms', initial = {}, bridge = true, probe = false, probeId = '' } = {}) {
  const init = JSON.stringify(initial || {}).replace(/</g, '\\u003c');
  const key = JSON.stringify(String(storageKey)).replace(/</g, '\\u003c');
  const pid = JSON.stringify(String(probeId || '')).replace(/</g, '\\u003c');
  // probe：隐藏沙箱里收集 onerror / unhandledrejection / console.error，约 2.5s 后回报白屏与错误。
  // 探针模式不把单条错误回传宿主，避免触发预览区的「让 AI 修复」。
  const probeJs = probe ? `
var PROBEID=${pid},errs=[];
function pushErr(message,line){var m=String(message||'Error').slice(0,300);if(!m)return;for(var i=0;i<errs.length;i++)if(errs[i].message===m)return;if(errs.length<12)errs.push({message:m,line:line||0})}
window.addEventListener('error',function(e){pushErr(e.message,e.lineno||0)});
window.addEventListener('unhandledrejection',function(e){pushErr('Unhandled promise rejection: '+String(e.reason&&e.reason.message||e.reason),0)});
try{var c=window.console;if(c&&c.error){var orig=c.error;c.error=function(){var parts=[];for(var i=0;i<arguments.length;i++)parts.push(String(arguments[i]));pushErr(parts.join(' ').slice(0,300),0);try{return orig.apply(c,arguments)}catch(e){}}}}catch(e){}
setTimeout(function(){var text='';try{text=(document.body&&(document.body.innerText||'')||'').replace(/\\s+/g,'')}catch(e){}
var nodes=0;try{var all=document.body?document.body.getElementsByTagName('*'):[];for(var i=0;i<all.length&&nodes<40;i++){var el=all[i];var tag=el.tagName;if(tag==='SCRIPT'||tag==='STYLE'||tag==='HEAD'||tag==='META'||tag==='LINK'||tag==='TITLE')continue;var r=el.getBoundingClientRect();if(r.width>1&&r.height>1)nodes++}}catch(e){}
var blank=text.length<10&&nodes<3;
post({__atoms:'runtime-report',type:'atoms-runtime-report',probeId:PROBEID,errors:errs,blank:blank,textLen:text.length,nodes:nodes})},2500);` : `
window.addEventListener('error',function(e){post({__atoms:'error',message:String(e.message||'Error'),line:e.lineno||0,col:e.colno||0})});
window.addEventListener('unhandledrejection',function(e){post({__atoms:'error',message:'Unhandled promise rejection: '+String(e.reason&&e.reason.message||e.reason)})});`;
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
${probeJs}
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
