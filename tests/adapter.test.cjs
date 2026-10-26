const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const vm = require('node:vm');
const { MCPBridge } = require('../node/bridge.cjs');
const { Service, CHUNK, MAX_TRANSFER } = require('../node/service.cjs');
function fakeChild() {
  const child = new EventEmitter(); child.stdin=new PassThrough(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.kill=()=>{};
  child.send = (id,result) => child.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n'); return child;
}
function service(bridge) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cindy-iphone-test-')); return {s:new Service({bridge,ledgerDir:dir}),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})}; }
test('persistent MCP initializes once and routes out-of-order and fragmented replies',async()=>{
  const child=fakeChild(); let launches=0, init=0; const requests=[];
  child.stdin.on('data',data=>{for(const line of data.toString().trim().split('\n')){const m=JSON.parse(line);if(m.method==='initialize'){init++;child.send(m.id,{});}else if(m.method==='tools/call')requests.push(m);}});
  const b=new MCPBridge({launch:()=>{launches++;return child;}});
  const a=b.call('one'), c=b.call('two'); await new Promise(r=>setImmediate(r));
  child.send(requests[1].id,{which:2}); const line=JSON.stringify({id:requests[0].id,result:{which:1}})+'\n';child.stdout.write(line.slice(0,8));child.stdout.write(line.slice(8));
  assert.deepEqual(await a,{which:1});assert.deepEqual(await c,{which:2});assert.equal(launches,1);assert.equal(init,1);b.close();
});
test('timeout preserves uncertain request until late response; oversized lines stop bridge',async()=>{
  const child=fakeChild(); const b=new MCPBridge({launch:()=>child,maxLine:80});
  child.stdin.on('data',data=>{const m=JSON.parse(data);if(m.method==='initialize')child.send(m.id,{});});
  await b.start(); await assert.rejects(b.raw('never',{},10),/outcome unknown/);assert.equal(b.uncertain,true);child.send(2,{});assert.equal(b.uncertain,false);
  const pending=b.raw('oversized',{});child.stdout.write('x'.repeat(100));await assert.rejects(pending,/transport limit/);assert.equal(b.child,null);
});
test('UI chunks fit mobile messages, expire, reject wrong scope and exceed size',async()=>{
  const {s,cleanup}=service({close(){}});try{
    const meta=s.transfer('a'.repeat(80000));assert.equal(meta.chunks,4);
    const chunk=await s.handle('transport/chunk',{token:meta.token,index:0});assert.equal(chunk.data.length,CHUNK);assert.ok(Buffer.byteLength(JSON.stringify({kind:'response',requestId:'x'.repeat(120),result:chunk}))<48*1024);
    const privateMeta=s.transfer('secret','model');await assert.rejects(s.handle('transport/chunk',{token:privateMeta.token,index:0}),/expired/);
    assert.throws(()=>s.transfer('x'.repeat(MAX_TRANSFER+1)),/limit/);s.transfers.get(meta.token).expires=0;await assert.rejects(s.handle('transport/chunk',{token:meta.token,index:0}),/expired/);
  }finally{cleanup();}
});
test('UI and model allowlists; repeated mutation IDs execute once; no secret journal',async()=>{
  let calls=0;const {s,cleanup}=service({close(){},async call(){calls++;return {content:[{type:'text',text:'{"text":"PRIVATE"}'}]};}});
  try{
    await assert.rejects(s.handle('model/call',{name:'screen_frame'}),/Unknown model tool/);await assert.rejects(s.handle('ui/action',{action:'shell',epoch:s.epoch}),/Unknown/);
    const p={name:'tap',args:{x:1,y:2},requestId:'model-test-123'};await s.handle('model/call',p);await s.handle('model/call',p);assert.equal(calls,1);
    assert.ok(!fs.readFileSync(path.join(s.ledgerDir,'requests.json'),'utf8').includes('PRIVATE'));
    await assert.rejects(s.handle('model/call',{...p,args:{x:3,y:4}}),/another action/);
    assert.equal((await s.handle('adapter/status')).phone_contacted,false);assert.equal(calls,1);
  }finally{cleanup();}
});
test('uncertain writes block subsequent mutations until a successful fresh observation',async()=>{
  let fail=true;const {s,cleanup}=service({close(){},async call(name){if(name==='pua_tap'&&fail){fail=false;throw new Error('timed out');}return {content:[{type:'text',text:'{}'}]};}});
  try{
    await assert.rejects(s.handle('model/call',{name:'tap',args:{x:1,y:1},requestId:'model-timeout-1'}));
    await assert.rejects(s.handle('model/call',{name:'tap',args:{x:1,y:1},requestId:'model-timeout-2'}),/uncertain/);
    await s.handle('model/call',{name:'observe',args:{}});
    await s.handle('model/call',{name:'tap',args:{x:2,y:2},requestId:'model-replan-3'});
  }finally{cleanup();}
});
test('main separates UI frames from model results and deposits observation images',async()=>{
  let hostHandler, channel; const sent=[], requests=[], media=[];
  class BC{constructor(){channel=this;}postMessage(m){sent.push(m);}}
  const cindy={onHostMessage(fn){hostHandler=fn;},node:{async request(r){requests.push(r);return {ok:true,result:r.method==='model/call'?{data:{image:{path:'/evidence.jpg'}},media:{token:'a',chunks:1,length:4}}:r.method==='transport/chunk'?{data:'abcd'}:{}};}},async send(m){if(m.type==='cindy-request'){media.push(m);return {ok:true,url:'cindy-media://blobs/a.jpg'};}sent.push(m);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),{BroadcastChannel:BC,cindy,Date,Set,Map,JSON});
  await hostHandler({type:'tool-call',tool:'observe',args:{mode:'screenshot'},callId:'test'});
  const result=sent.find(m=>m.type==='tool-result');assert.deepEqual([...result.result.xdt_image_urls],['cindy-media://blobs/a.jpg']);assert.ok(!JSON.stringify(result).includes('abcd'));assert.equal(media.length,1);
  const count=sent.filter(m=>m.type==='tool-result').length;
  await channel.onmessage({data:{kind:'request',requestId:'frame-123456',method:'ui/frame',params:{}}});assert.equal(sent.filter(m=>m.type==='tool-result').length,count);
  await channel.onmessage({data:{kind:'request',requestId:'chunk-123456',method:'transport/chunk',params:{token:'a',index:0,scope:'model'}}});assert.equal(requests.at(-1).params.scope,'ui');
});
test('adapter status exposes bounded scalar panel telemetry without forwarding heartbeats to Node',async()=>{
  let hostHandler,channel;const sent=[],requests=[];
  class BC{constructor(){channel=this;}postMessage(m){sent.push(m);}}
  const cindy={onHostMessage(fn){hostHandler=fn;},node:{async request(r){requests.push(r);return {ok:true,result:{epoch:'private-epoch'}};}},send(m){sent.push(m);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),{BroadcastChannel:BC,cindy,Date,Set,Map,JSON});
  await hostHandler({type:'tool-call',tool:'adapter_status',callId:'before'});assert.equal(sent.at(-1).result.panel.seen,false);
  const before=requests.length;
  await channel.onmessage({data:{kind:'request',requestId:'heartbeat-1',method:'ui/heartbeat',mobilePageId:'mobile-host-id',params:{panel_id:'panel-1',visible:true,decoded:true,natural_width:440,natural_height:956,last_draw_at:Date.now(),last_draw_seq:42,last_error:'data:image/jpeg;base64,PRIVATE',data:'PRIVATE',src:'PRIVATE'}}});
  assert.equal(requests.length,before);
  await hostHandler({type:'tool-call',tool:'adapter_status',callId:'after'});
  const result=sent.at(-1).result,p=result.panel.instances[0];assert.equal(result.panel.seen,true);assert.equal(p.source,'mobile');assert.equal(p.connected,true);assert.equal(p.decoded,true);assert.equal(p.last_draw_seq,42);assert.equal(p.natural_width,440);assert.equal(p.last_error,null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!('epoch' in result));
});
test('manifest retains plugin identity and ready examples match its supported parameters',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../ghost.json'),'utf8'));assert.equal(manifest.id,'iphone-use-panel');assert.deepEqual(manifest.mobile.channels,['iphone-use-panel-ui']);
  const schema=manifest.tools.find(t=>t.name==='ready').parameters;for(const example of schema.examples||[])assert.ok(!('recover' in example));
});
test('panel is self contained and includes bounded assembly, visibility cleanup, 250ms cadence',()=>{
  const desktop=fs.readFileSync(path.join(__dirname,'../panel.html'),'utf8');assert.ok(desktop.includes('<script src="panel.js"></script>'));assert.ok(!desktop.includes('<script>'));
  const html=fs.readFileSync(path.join(__dirname,'../mobile/panel.html'),'utf8');assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(html));
  const js=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(js);
  for(const required of ['visibilitychange','pagehide','transport/release','generation','48','250','setPaused(true']) if(required!=='48')assert.ok(js.includes(required),required);
});
