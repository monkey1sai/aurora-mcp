import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { RenderJob, AdmissionBudget } from '../cloud-worker.mjs';
import { createRooms } from '../rooms.mjs';
import { designSfx } from '../../src/creation/compose.js';
import { renderProject, encodePcmWav } from '../../src/creation/render.js';
const studio = await fs.readFile(new URL('../../src/creation/studio.js', import.meta.url), 'utf8');
const extract = (start,end) => studio.slice(studio.indexOf(start), studio.indexOf(end,studio.indexOf(start)));
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve}; };
test('revoking while browser poll is pending cannot apply stale commands',async()=>{
  const pending=deferred(),ctx={room:'old',commandEpoch:0,request:()=>pending.promise,replace:()=>assert.fail('stale command applied'),$:()=>({}),disconnect:()=>{},worker:null};
  vm.createContext(ctx);vm.runInContext(extract('async function poll()', 'async function disconnect()'),ctx);
  const work=ctx.poll();ctx.room=null;pending.resolve({commands:[{action:'apply_project',project:{}}]});await work;
});
test('stop or room revocation during audio decode prevents source.start',async()=>{
  for(const mode of ['stop','revoke']){
    const decode=deferred();let starts=0;
    const ctx={wav:new ArrayBuffer(44),source:null,playEpoch:0,allowed:true,Error,status:()=>{},context:{decodeAudioData:()=>decode.promise,createBufferSource:()=>({connect(){},start(){starts++;}})}};
    vm.createContext(ctx);vm.runInContext(extract('function stop()', 'function cancel(')+extract('async function play(', 'function download('),ctx);
    const work=ctx.play(()=>ctx.allowed);if(mode==='stop')ctx.stop();else ctx.allowed=false;decode.resolve({});await assert.rejects(work,/CANCELLED/);assert.equal(starts,0);
  }
});
test('expired browser rooms release all admission slots',()=>{
  const original=Date.now;let now=original();Date.now=()=>now;
  try{const rooms=createRooms();for(let i=0;i<16;i++)rooms.enable();now+=31*60000;assert.ok(rooms.enable().room);rooms.close();}finally{Date.now=original;}
});
test('stop cancels commands already fetched in another browser batch',async()=>{
  const rendering=deferred();let polls=0,renders=0,plays=0;
  const ctx={room:'room',commandEpoch:0,worker:null,context:{state:'running'},$:()=>({}),disconnect(){},replace(){},stop(){},cancel(){rendering.resolve();},async render(){renders++;await rendering.promise;throw new Error('cancelled');},async play(){plays++;},async request(url,method){if(method==='POST')return {};return {commands:++polls===1?[{action:'play_project',project:{},requestId:'a'},{action:'play_project',project:{},requestId:'b'}]:[{action:'stop',requestId:'stop'}]};}};
  vm.createContext(ctx);vm.runInContext(extract('async function poll()', 'async function disconnect()'),ctx);
  const old=ctx.poll();await new Promise(r=>setImmediate(r));await ctx.poll();await old;assert.equal(renders,1);assert.equal(plays,0);
});
function memoryStorage(){const values=new Map();return {values,async get(k){return values.get(k);},async put(k,v){values.set(k,v);},async deleteAll(){values.clear();},async setAlarm(){},async transaction(fn){return fn(this);}};}
test('public admission budget bounds jobs, bytes and requests and fails closed',async()=>{
  const storage=memoryStorage(),budget=new AdmissionBudget({storage});
  const reserve=input=>budget.fetch(new Request('https://budget/allow',{method:'POST',body:JSON.stringify(input)}));
  for(let i=0;i<3;i++)assert.equal((await reserve({bytes:32000000})).status,200);
  assert.equal((await reserve({bytes:5000000})).status,429);
  assert.equal((await reserve({bytes:32000001})).status,400);
  const day=new Date().toISOString().slice(0,10);await storage.put('counter',{day,requests:4999,jobs:20,bytes:0});
  assert.equal((await reserve({bytes:44})).status,429);assert.equal((await reserve({})).status,200);assert.equal((await reserve({})).status,429);
});
test('cloud upload is exact 16-bit WAV, immutable, and cannot resurrect an expired job',async()=>{
  const storage=memoryStorage(),job=new RenderJob({storage}),project=designSfx({type:'ui',seconds:.1}),options={sampleRate:16000,bitDepth:16,tailSeconds:0};
  const create=()=>job.fetch(new Request('https://job/create',{method:'POST',body:JSON.stringify({id:'00000000-0000-4000-8000-000000000001',project,options,origin:'https://example.test'})}));
  assert.equal((await create()).status,201);
  const rendered=renderProject(project,options);const wav=encodePcmWav(rendered.L,rendered.R,16000,16);
  const put=()=>job.fetch(new Request('https://job/audio',{method:'PUT',body:wav}));
  assert.equal((await put()).status,200);assert.equal((await put()).status,409);
  const status=await (await job.fetch(new Request('https://job/status'))).json();assert.equal(status.status,'artifact-ready');assert.equal(status.metrics.verifiedWav.bitDepth,16);
  await storage.deleteAll();assert.equal((await create()).status,201);
  const body=deferred();const request={url:'https://job/audio',method:'PUT',headers:new Headers(),body:{getReader(){let done=false;return {async read(){if(done)return {done:true};done=true;await body.promise;return {done:false,value:wav};}};}}};
  const pending=job.fetch(request);await new Promise(r=>setImmediate(r));await job.alarm();body.resolve();
  assert.equal((await pending).status,404);assert.equal(storage.values.size,0);
});
