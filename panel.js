
(() => { 'use strict';
const bc = new BroadcastChannel('iphone-use-panel-ui'), img = document.getElementById('image'), empty = document.getElementById('empty'), device = document.getElementById('device'), status = document.getElementById('status'), error = document.getElementById('error');
const buttons = Object.fromEntries(['refresh','home','screenshot','pause'].map(n => [n,document.getElementById(n)]));
const words = { en: { connecting:'Connecting',live:'Live',offline:'Preview unavailable',paused:'Preview paused; finish authentication on the iPhone',failed:'Action outcome unknown. Inspect phone state before trying again.',oversize:'Frame exceeds the 8 MiB limit.',expired:'Frame transfer expired.' }, 'zh-CN': {connecting:'连接中',live:'实时画面',offline:'画面暂不可用',paused:'预览已暂停；请在 iPhone 上完成认证',failed:'操作结果未知，请先检查手机状态。',oversize:'画面超过 8 MiB 限制。',expired:'画面传输已过期。'} };
let labels = words.en, localPaused = false, active = true, visible = !document.hidden, epoch, generation = 0, seq = 0, stream = '', eventId = 0, timer, busy = false, fail = 0, frame = null, lastPoll = 0;
const panelId = 'panel-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let lastDrawAt=0,lastDrawSeq=0,errorCount=0,lastError=null;
let serial = 0; const pending = new Map(); const nextId = () => panelId + '-' + (++serial).toString(36);
function heartbeat(){bc.postMessage({kind:'request',requestId:nextId(),method:'ui/heartbeat',params:{panel_id:panelId,visible,paused:document.body.dataset.paused==='true',image_visible:visible&&!img.hidden&&document.body.dataset.paused!=='true',decoded:!!frame?.decoded,natural_width:img.naturalWidth||0,natural_height:img.naturalHeight||0,last_draw_at:lastDrawAt,last_draw_seq:lastDrawSeq,last_poll_at:lastPoll,error_count:errorCount,last_error:lastError}});}
function reportError(kind){errorCount++;lastError=kind;heartbeat();}
img.onload=()=>{if(!frame||document.body.dataset.paused==='true'||!img.naturalWidth||!img.naturalHeight)return;frame.decoded=true;seq=frame.seq;lastDrawSeq=seq;lastDrawAt=Date.now();img.hidden=false;empty.hidden=true;text(labels.live);showError('');heartbeat();};
img.onerror=()=>{frame=null;seq=0;img.hidden=true;empty.hidden=false;empty.textContent=labels.offline;text(labels.offline);showError('Preview image could not be decoded.');reportError('decode');};
setInterval(heartbeat,5000);
window.addEventListener('error',()=>reportError('runtime'));
window.addEventListener('unhandledrejection',()=>reportError('runtime'));
function request(method, params = {}, timeout = 4000, stableId) {
  const requestId = stableId || nextId();
  return new Promise((resolve,reject) => {
    const message={kind:'request',requestId,method,params};
    const retry = method==='adapter/status' ? setInterval(()=>bc.postMessage(message),400) : null;
    const timer = setTimeout(() => { clearInterval(retry); pending.delete(requestId); reject(new Error(labels.failed)); }, timeout);
    pending.set(requestId,{resolve,reject,timer,retry}); bc.postMessage(message);
  });
}
bc.onmessage = ({data:m}) => { if(m?.kind !== 'response') return; const p=pending.get(m.requestId); if(!p) return; clearTimeout(p.timer); clearInterval(p.retry); pending.delete(m.requestId); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); };
function text(value){ status.textContent = 'iPhone · ' + value; }
function showError(value){ error.textContent = value; }
function setPaused(value,reason){ document.body.dataset.paused = String(value); buttons.pause.textContent = value ? 'Resume' : 'Pause'; buttons.home.disabled = buttons.screenshot.disabled = value || busy; if(value){ img.hidden=true; frame=null; seq=0; img.removeAttribute('src'); empty.hidden=false; empty.textContent=reason==='device_locked' ? 'Unlock your iPhone' : labels.paused; text(labels.paused); } }
async function chunks(meta, expectedGeneration){
  if(!meta || !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 342 || !Number.isInteger(meta.length) || meta.length < 0 || meta.length > 8*1024*1024) throw new Error(labels.oversize);
  let result = ''; const deadline=Date.now()+15000;
  try { for(let i=0;i<meta.chunks;i++) { if(expectedGeneration !== generation || !active || !visible) return null;
    if(Date.now()>deadline)throw new Error(labels.expired);
    const part = await request('transport/chunk',{token:meta.token,index:i}); if(part.index!==i || typeof part.data!=='string' || part.data.length>24576) throw new Error(labels.oversize); result+=part.data;
    if(result.length>meta.length) throw new Error(labels.oversize);
  } if(result.length!==meta.length) throw new Error(labels.expired); return JSON.parse(result);
  } finally { request('transport/release',{token:meta.token}).catch(()=>{}); }
}
function consume(value){
  if(!value || typeof value !== 'object') return;
  if(value.stream_id && value.stream_id !== stream){stream=value.stream_id;seq=0;eventId=0;}
  if(value.paused || localPaused){setPaused(true,value.pause_reason);heartbeat();return;} setPaused(false);
  if(value.frame_available===false){text(labels.offline);if(!frame){empty.hidden=false;empty.textContent=labels.offline;}return;}
  const f=value.frame;
  if(f && Number.isInteger(f.seq) && f.seq>seq && f.data && f.data.length<=8*1024*1024 && /^image\/(jpeg|png|webp)$/.test(f.mimeType) && f.width>0 && f.height>0){
    if(frame && !frame.decoded) return;
    frame={seq:f.seq,decoded:false}; device.style.aspectRatio=f.width+' / '+f.height; device.style.height='100%'; img.src='data:'+f.mimeType+';base64,'+f.data;
  }
  if(Array.isArray(value.events)) for(const e of value.events) if(Number.isInteger(e.id)) eventId=Math.max(eventId,e.id);
}
function schedule(ms){ if(!active||!visible||timer) return; timer=setTimeout(()=>{timer=null;poll();},ms); }
async function poll(){if(!active||!visible||busy)return;busy=true; const id=++generation, started=performance.now(); lastPoll=Date.now();
  try { if(!epoch) epoch=(await request('adapter/status',{})).epoch; const meta=await request('ui/frame',{after_seq:seq,last_event_id:eventId},6500); const data=await chunks(meta,id); if(id===generation && active && visible && data){consume(data);fail=0;} }
  catch(e){fail++;epoch=undefined;if(fail>1)text(labels.offline);showError(e.message || labels.offline);reportError('poll');}
  finally{busy=false;buttons.home.disabled=buttons.screenshot.disabled=document.body.dataset.paused==='true';schedule(fail?Math.min(2500,fail*500):Math.max(0,250-(performance.now()-started)));}
}
async function action(name){ if(!active || buttons[name].disabled)return; const operation=name==='pause' && document.body.dataset.paused==='true'?'resume':name;
  // Keep the identity stable for a single click. Timeouts are unknown outcomes; no automatic write retry.
  const requestId=nextId(); buttons[name].disabled=true; generation++;
  if(operation==='pause'){localPaused=true;setPaused(true,'authentication');}
  try{ const response=await request('ui/action',{action:operation,epoch},18000,requestId);
    if(response.isError || response.data?.error) throw new Error(response.data?.error?.message || labels.failed);
    if(operation==='pause'||operation==='resume'){localPaused=!!response.data.paused;seq=0;setPaused(localPaused,response.data.pause_reason);}
    if(operation==='refresh'){seq=0;stream='';frame=null;img.hidden=true;img.removeAttribute('src');empty.hidden=false;empty.textContent=labels.connecting;text(labels.connecting);localPaused=!!response.data.paused;setPaused(localPaused,response.data.pause_reason);} showError('');clearTimeout(timer);timer=null;schedule(0);heartbeat();
  }catch(e){showError(e.message || labels.failed);reportError('action');}finally{buttons[name].disabled=false;}
}
for(const name of Object.keys(buttons)) buttons[name].onclick=()=>action(name);
function wake(){if(!window.cindyMobile) fetch('cindy-ghost://iphone-use-panel/wake').catch(()=>{});}
function visibility(){visible=!document.hidden && active;if(!visible){generation++;clearTimeout(timer);timer=null;}else{wake();schedule(0);}heartbeat();}
document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',()=>{active=false;visibility();});window.addEventListener('pageshow',()=>{active=true;visibility();});
fetch('/app-context').then(r=>r.json()).then(r=>{const locale=r.context?.locale||r.locale;if(words[locale]) labels=words[locale]; if(locale==='zh-CN'){buttons.refresh.textContent='刷新';buttons.home.textContent='主屏幕';buttons.screenshot.textContent='截图';buttons.pause.textContent='暂停';} }).catch(()=>{});
// Mobile bridges the declared channel directly; desktop wakes its own sandbox.
// A stalled wake must not prevent status retries or heartbeat delivery.
wake();
heartbeat();
request('adapter/status',{}).then(r=>{epoch=r.epoch;heartbeat();schedule(0);}).catch(e=>{text(labels.offline);showError(e.message);reportError('startup');schedule(1000);});
})();
