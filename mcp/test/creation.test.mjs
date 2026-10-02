import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as P from '../../src/creation/project.js';
import * as C from '../../src/creation/compose.js';
import { renderProject, encodePcmWav, renderPlan } from '../../src/creation/render.js';
import { decodeWav } from '../../tools/wav.mjs';
import { Project } from '../schemas.mjs';
import { createRooms } from '../rooms.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const render = p => { const r=renderProject(p,{sampleRate:16000,tailSeconds:0.25});return {...r,wav:encodePcmWav(r.L,r.R,16000,24)}; };
test('five creative axes produce explicit and independently editable musical decisions',()=>{
  const base={rhythm:{bars:1,rest:0},expression:{humanize:0},motive:{intervals:[0,2,4],durations:[0.25,0.25,0.5]},harmony:{progression:[0]}};
  const a=C.compose(P.createProject({axes:base})), notes=p=>p.tracks[0].events;
  const make=change=>C.compose(P.createProject({axes:{...base,...change}}));
  assert.notDeepEqual(notes(a),notes(make({motive:{...base.motive,development:'invert'}})));
  assert.notDeepEqual(notes(a),notes(make({rhythm:{...base.rhythm,density:0.25}})));
  assert.notDeepEqual(notes(a).map(e=>e.note),notes(make({harmony:{...base.harmony,root:5,scale:'major'}})).map(e=>e.note));
  assert.notDeepEqual(notes(a).map(e=>e.vel),notes(make({expression:{start:0.1,end:0.2,humanize:0}})).map(e=>e.vel));
  const dark=make({timbre:{brightness:0.1,space:0}});assert.notEqual(a.tracks[0].patch.params['filter.cutoff'],dark.tracks[0].patch.params['filter.cutoff']);
  const scale=[0,2,3,5,7,8,10];assert.ok(notes(a).every(e=>scale.includes(e.note%12)));
});
test('seeded project, automation and WAV are reproducible; changing a noise seed changes the WAV',()=>{
  const p=C.designSfx({type:'whoosh',seconds:0.5,seed:42});
  const a=render(p),b=render(p);assert.equal(hash(a.wav),hash(b.wav));
  assert.notEqual(hash(a.wav),hash(render(C.designSfx({type:'whoosh',seconds:0.5,seed:43})).wav));
  const decoded=decodeWav(Buffer.from(a.wav));assert.equal(decoded.bitDepth,24);assert.equal(decoded.sampleRate,16000);assert.equal(decoded.channels.length,2);
  assert.ok(a.metrics.peakDbFS>-100);assert.ok(a.L.every(Number.isFinite));assert.ok(a.L.at(-1)===0);
});
test('all nine SFX recipes validate and generate finite, non-silent stereo WAV',()=>{
  for(const type of C.SFX_TYPES){const p=C.designSfx({type,seconds:0.4}),r=render(p);assert.ok(r.metrics.peakDbFS>-100,type);assert.equal(r.wav.length,r.plan.bytes);Project.parse(p);}
});
test('all factory presets, complete songs, tours and Jam styles retain valid editable contracts',()=>{
  const catalog=C.catalog();assert.equal(catalog.presets.length,100);assert.equal(P.parameterSchema().length,235);
  for(const p of catalog.presets)P.validatePatch(P.patchFromPreset(p.name));
  for(const s of catalog.songs){const p=C.loadSong(s.id);Project.parse(p);renderPlan(p);assert.ok(p.tracks.length>1);Project.parse(C.loadSong(s.id,8));}
  for(const t of catalog.tours)for(const mode of ['final','timeline'])Project.parse(C.loadTour(t.id,mode));
  for(const style of catalog.styles){const p=C.jamProject({style,axes:{rhythm:{bars:4}}});Project.parse(p);assert.equal(p.lengthBeats,16);assert.ok(p.tracks.length>1);}
  assert.throws(()=>C.jamProject({axes:{rhythm:{bars:1}}}),/jam.bars/);
});
test('moods, macro-aware morph, randomization and evolution use website implementations',()=>{
  const p=C.compose(P.createProject({axes:{rhythm:{bars:1}}}));
  for(const m of C.catalog().moods)Project.parse(C.moodProject(p,[m.id]));
  assert.deepEqual(C.morphProject(p,'Velvet Dusk',0).tracks[0].patch.params,Object.fromEntries(P.parameterSchema().filter(p=>p.scope!=='global').map(s=>[s.id,p.tracks[0].patch.params[s.id]??s.def])));
  for(const value of [C.morphProject(p,'Velvet Dusk',0.5),C.mutateProject(p),C.mutateProject(p,{random:true}),C.evolveProject(p)])Project.parse(value);
  assert.deepEqual(C.mutateProject(p),C.mutateProject(p));assert.deepEqual(C.moodProject(p,'更暗、再寬一點').axes,p.axes);
});
test('renderer handles multipart music and sequencer ramps, with explicit tail warnings',()=>{
  const p=C.loadSong('aurora-dreams',2),r=render(p);assert.equal(r.metrics.tracks,6);assert.ok(r.metrics.peakDbFS>-60);
  const ramp=C.designSfx({type:'laser',seconds:0.4});ramp.tracks[0].events.push({beat:0,type:'ramp',id:'filter.cutoff',to:500,beats:ramp.lengthBeats});P.validateProject(ramp);assert.ok(render(ramp).L.every(Number.isFinite));
});
test('reject unknown params, wrong scope, invalid ranges, malformed notes, oversize work and stale revision before rendering',()=>{
  const p=P.createProject({axes:{rhythm:{bars:1}}});
  for(const values of [{'fake.key':1},{'filter.cutoff':Infinity},{'voice.poly':99},{'osc1.mode':'invalid'}])assert.throws(()=>P.setParameters(p,values));
  assert.throws(()=>P.setParameters(p,{'filter.cutoff':200},0,100),/current/);
  assert.throws(()=>P.setParameters(p,{'scale.type':'major'},0,-1));
  assert.throws(()=>renderPlan(p,{sampleRate:96000}));assert.throws(()=>renderPlan(p,{tailSeconds:100}));assert.throws(()=>renderPlan(p,{path:'../../secret'}));
  const tooLong=P.copy(p);tooLong.lengthBeats=720;tooLong.globals['global.bpm']=40;assert.throws(()=>P.validateProject(tooLong),/180s/);
  const note=P.copy(p);note.tracks[0].events=[{beat:3.9,type:'on',note:60,vel:1,dur:1}];assert.throws(()=>P.validateProject(note),/exceeds/);
  const partial=P.copy(p);partial.axes={};assert.throws(()=>P.validateProject(partial),/complete/);
  const mixed=P.copy(p);mixed.tracks[0].patch.params['global.bpm']=100;assert.throws(()=>P.validateProject(mixed),/scope/);
  assert.equal(p.revision,0);
});
test('global tempo and scale are preserved outside patch, and custom patches retain macro definitions',()=>{
  const p=P.setParameters(P.createProject(),{'global.bpm':80,'scale.type':'minor','filter.cutoff':800});assert.equal(p.globals['global.bpm'],80);assert.equal(p.tracks[0].patch.params['filter.cutoff'],800);assert.equal(p.tracks[0].patch.params['global.bpm'],undefined);
});
test('original Init and custom macros round-trip through creation without losing globals or mappings',async()=>{
  const {createStore}=await import('../../src/ui/app/store.js');const store=createStore();
  const init=store.toPatch();assert.equal(init.category,null);const initial=P.createProject({patch:init});assert.deepEqual(initial.tracks[0].patch,init);
  store.setMany({'global.bpm':84,'scale.root':2,'scale.type':'minor'});
  store.setMacroDefs([{name:'Pressure',targets:Array.from({length:20},()=>({id:'filter.cutoff',amount:.01})).concat([{id:'master.volume',amount:.2}])}]);
  const patch=store.toPatch(),p=P.setParameters(P.createProject({patch}),store.globals());Project.parse(p);
  assert.deepEqual(p.tracks[0].patch.macros,patch.macros);assert.deepEqual(p.globals,store.globals());
  const restored=createStore();restored.loadPreset(p.tracks[0].patch);restored.setMany(p.globals);assert.deepEqual(restored.toPatch().macros,patch.macros);assert.deepEqual(restored.globals(),store.globals());
});
test('browser rooms are explicit, deduplicate retries and report queue vs applied vs revoked states',()=>{
  const rooms=createRooms(),{room}=rooms.enable(),p=P.createProject();
  const command={room,requestId:'once',action:'apply_project',project:p};assert.equal(rooms.command(command).status,'queued');rooms.command(command);assert.equal(rooms.poll(room).commands.length,1);
  rooms.ack(room,{requestId:'once',status:'project-applied'});assert.equal(rooms.command(command).status,'project-applied');assert.equal(rooms.poll(room).commands.length,0);
  rooms.disable(room);assert.throws(()=>rooms.command(command),/disabled/);rooms.close();
});
test('stop cancels older queued play and apply commands instead of replaying them',()=>{
  const rooms=createRooms(),{room}=rooms.enable();
  for(const [requestId,action]of [['play','play_project'],['apply','apply_project']])rooms.command({room,requestId,action,project:P.createProject()});
  rooms.command({room,requestId:'stop',action:'stop'});assert.deepEqual(rooms.poll(room).commands.map(x=>x.action),['stop']);
  assert.equal(rooms.status(room,'play').status,'cancelled');assert.equal(rooms.poll(room).commands.length,0);rooms.close();
});
test('stop remains available after filling the bounded command history',()=>{
  const rooms=createRooms(),{room}=rooms.enable(),project=P.createProject();
  for(let i=0;i<256;i++){rooms.command({room,requestId:String(i),action:'apply_project',project});rooms.poll(room);rooms.ack(room,{requestId:String(i),status:'project-applied'});}
  assert.equal(rooms.command({room,requestId:'stop',action:'stop'}).status,'queued');assert.equal(rooms.poll(room).commands[0].action,'stop');rooms.close();
});
test('Morph preserves global macro mappings without baking global values into a patch',()=>{
  const p=P.createProject();p.tracks[0].patch.macros=[{name:'Tempo',targets:[{id:'global.bpm',amount:.2},{id:'master.volume',amount:.3}]}];p.tracks[0].patch.params.macro1=.7;
  const q=C.morphProject(p,'Velvet Dusk',.25);Project.parse(q);assert.deepEqual(q.globals,p.globals);assert.deepEqual(q.tracks[0].patch.macros,p.tracks[0].patch.macros);assert.equal(q.tracks[0].patch.params['global.bpm'],undefined);assert.equal(q.tracks[0].patch.params['master.volume'],undefined);
});
