import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderJob, AdmissionBudget } from '../cloud-worker.mjs';
import { designSfx } from '../../src/creation/compose.js';
import { renderProject, encodePcmWav } from '../../src/creation/render.js';
class Storage {
  constructor(){this.values=new Map();}
  async get(k){return structuredClone(this.values.get(k));}
  async put(k,v){this.values.set(k,structuredClone(v));}
  async setAlarm(time){this.alarm=time;}
  async deleteAll(){this.values.clear();}
  async transaction(fn){return fn(this);}
}
const setup=async()=>{
  const state={storage:new Storage()},job=new RenderJob(state),project=designSfx({type:'ui',seconds:.1}),options={sampleRate:16000,tailSeconds:0,bitDepth:16};
  const r=await job.fetch(new Request('https://job/create',{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),project,options,origin:'https://test.example'})}));assert.equal(r.status,201);
  const audio=renderProject(project,options),wav=encodePcmWav(audio.L,audio.R,16000,16);return {state,job,wav};
};
test('cloud job validates actual WAV, refuses replacement and removes expired state',async()=>{
  const {state,job,wav}=await setup();assert.equal((await job.fetch(new Request('https://job/audio',{method:'PUT',body:'invalid'}))).status,400);
  const upload=await job.fetch(new Request('https://job/audio',{method:'PUT',body:wav}));assert.equal(upload.status,200);
  const status=await (await job.fetch(new Request('https://job/status'))).json();assert.equal(status.status,'artifact-ready');assert.equal(status.bytes,wav.length);assert.equal(status.metrics.verifiedWav.bitDepth,16);
  assert.equal((await job.fetch(new Request('https://job/audio',{method:'PUT',body:wav}))).status,409);
  await job.alarm();assert.equal(state.storage.values.size,0);assert.equal((await job.fetch(new Request('https://job/status'))).status,404);
});
test('a slow PUT cannot commit past expiry, and a simultaneous PUT is rejected',async()=>{
  const {state,job,wav}=await setup();let writer;
  const body=new ReadableStream({start(c){writer=c;}});
  const pending=job.fetch(new Request('https://job/audio',{method:'PUT',body,duplex:'half'}));
  assert.equal((await job.fetch(new Request('https://job/audio',{method:'PUT',body:wav}))).status,409);
  const value=await state.storage.get('job');value.expiresAt=Date.now()-1;await state.storage.put('job',value);
  writer.enqueue(wav);writer.close();assert.equal((await pending).status,404);assert.equal(state.storage.values.has('a0'),false);
});
test('global daily admission refuses byte, job and request overflow; resets on next UTC day',async()=>{
  const state={storage:new Storage()},budget=new AdmissionBudget(state);
  const reserve=bytes=>budget.fetch(new Request('https://budget/allow',{method:'POST',body:JSON.stringify(bytes===undefined?{}:{bytes})}));
  for(let i=0;i<3;i++)assert.equal((await reserve(32000000)).status,200);assert.equal((await reserve(32000000)).status,429);
  await state.storage.deleteAll();for(let i=0;i<20;i++)assert.equal((await reserve(44)).status,200);assert.equal((await reserve(44)).status,429);
  await state.storage.deleteAll();for(let i=0;i<5000;i++)assert.equal((await reserve()).status,200);assert.equal((await reserve()).status,429);
  const counter=await state.storage.get('counter');counter.day='2000-01-01';await state.storage.put('counter',counter);assert.equal((await reserve()).status,200);
});
