const { test } = require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path'); const vm=require('node:vm');
function panel({mobile=false, stalledWake=false}={}){
  const nodes={},listeners={},windowEvents={},out=[],timers=new Map();let counter=0,bc;
  const node=id=>nodes[id] ||= {textContent:'',disabled:false,hidden:false,style:{},removeAttribute(name){delete this[name];}};
  const document={hidden:false,body:{dataset:{}},getElementById:node,addEventListener:(n,fn)=>listeners[n]=fn};
  const window={...(mobile?{cindyMobile:{}}:{}),addEventListener:(n,fn)=>windowEvents[n]=fn};
  class BC{constructor(){bc=this;}postMessage(m){out.push(m);}}
  const timeout=(fn,ms)=>{const id=++counter;timers.set(id,{fn,ms});return id;};
  const context={document,window,BroadcastChannel:BC,fetch:url=>stalledWake&&url.includes('/wake')?new Promise(()=>{}):Promise.resolve({json:async()=>({context:{locale:'en'}})}),setTimeout:timeout,setInterval:timeout,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),performance:{now:()=>0},Date,Map,Set,JSON};
  const html=fs.readFileSync(path.join(__dirname,'../panel.html'),'utf8');vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../panel.js'),'utf8'),context);
  const answer=(request,result)=>bc.onmessage({data:{kind:'response',requestId:request.requestId,result}});
  return {nodes,node,listeners,windowEvents,out,timers,document,answer};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('startup does not wait for desktop wake; mobile and multiple panels have unique request IDs',async()=>{
  const a=panel({stalledWake:true}),b=panel({mobile:true});await flush();
  for(const p of [a,b]){
    assert.ok(p.out.some(m=>m.method==='adapter/status'));
    const heartbeat=p.out.find(m=>m.method==='ui/heartbeat');assert.equal(heartbeat.params.decoded,false);assert.equal(heartbeat.params.last_draw_at,0);
    const periodic=[...p.timers.values()].find(t=>t.ms===5000);assert.ok(periodic);periodic.fn();assert.equal(p.out.at(-1).method,'ui/heartbeat');
  }
  assert.notEqual(a.out[0].requestId,b.out[0].requestId);
  const html=fs.readFileSync(path.join(__dirname,'../panel.html'),'utf8');assert.match(html,/\[hidden\]\{display:none!important\}/);
});
test('decode errors and page lifecycle are visible in pixel-free heartbeats',()=>{
  const p=panel();p.nodes.image.onerror();assert.equal(p.out.at(-1).params.last_error,'decode');assert.equal(p.out.at(-1).params.decoded,false);
  p.windowEvents.pagehide();assert.equal(p.out.at(-1).params.visible,false);
  p.document.hidden=true;p.windowEvents.pageshow();assert.equal(p.out.at(-1).params.visible,false);
  p.document.hidden=false;p.listeners.visibilitychange();assert.equal(p.out.at(-1).params.visible,true);
});
test('mobile panel chunks assemble in order; hide stops next poll and pause erases pixels immediately',async()=>{
  const p=panel();await flush();p.answer(p.out.find(m=>m.method==='adapter/status'),{epoch:'epoch-123'});await flush();
  const schedule=[...p.timers].find(([id,t])=>t.ms===0);assert.ok(schedule);p.timers.delete(schedule[0]);schedule[1].fn();
  const frameRequest=p.out.at(-1);assert.equal(frameRequest.method,'ui/frame');
  const payload=JSON.stringify({stream_id:'stream',frame_available:true,frame:{seq:1,mimeType:'image/jpeg',data:'AAAA',width:440,height:956}});
  p.answer(frameRequest,{token:'token',chunks:1,length:payload.length});await flush();p.answer(p.out.at(-1),{index:0,data:payload});await flush();
  assert.equal(p.nodes.image.src,'data:image/jpeg;base64,AAAA');
  p.nodes.image.naturalWidth=440;p.nodes.image.naturalHeight=956;p.nodes.image.onload();
  assert.equal(p.nodes.image.hidden,false);assert.equal(p.nodes.empty.hidden,true);
  const heartbeat=p.out.at(-1);assert.equal(heartbeat.method,'ui/heartbeat');assert.equal(heartbeat.params.decoded,true);assert.equal(heartbeat.params.last_draw_seq,1);assert.equal(heartbeat.params.natural_width,440);assert.ok(!JSON.stringify(heartbeat).includes('AAAA'));
  p.document.hidden=true;p.listeners.visibilitychange();assert.equal([...p.timers.values()].filter(t=>t.ms===250).length,0);
  p.nodes.pause.onclick();assert.equal(p.nodes.image.hidden,true);assert.equal(p.nodes.image.src,undefined);
  const action=p.out.at(-1);assert.equal(action.method,'ui/action');assert.equal(action.params.action,'pause');
  p.answer(action,{data:{paused:true},isError:false});await flush();assert.equal(p.document.body.dataset.paused,'true');
});
test('oversize metadata is rejected before requesting any chunk',async()=>{
  const p=panel();await flush();p.answer(p.out.find(m=>m.method==='adapter/status'),{epoch:'epoch-123'});await flush();
  const schedule=[...p.timers].find(([id,t])=>t.ms===0);p.timers.delete(schedule[0]);schedule[1].fn();p.answer(p.out.at(-1),{token:'bad',chunks:999,length:99999999});await flush();
  assert.equal(p.out.filter(m=>m.method==='transport/chunk').length,0);assert.match(p.nodes.error.textContent,/limit/);
});
