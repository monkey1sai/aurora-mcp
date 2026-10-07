import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttp } from '../http.mjs';
import * as P from '../../src/creation/project.js';
import * as C from '../../src/creation/compose.js';
import * as L from '../../src/creation/library.js';
import { evolveTargets as panelTargets, driftNoise as panelNoise } from '../../src/demo/drift.js';
import { parsePresetFile } from '../../src/ui/app/patchTools.js';
import { Project } from '../schemas.mjs';
import { createHash } from 'node:crypto';
import { renderProject, encodePcmWav } from '../../src/creation/render.js';
import { presetValues, effectiveValues } from '../../src/demo/morph.js';
import { PARAM_BY_ID, toNorm } from '../../src/dsp/params.js';
import { PATCH_IDS } from '../../src/ui/app/store.js';
const audioHash=x=>{const o=renderProject(x,{sampleRate:16000,tailSeconds:0});return createHash('sha256').update(Buffer.from(encodePcmWav(o.L,o.R,16000,16))).digest('hex');};
const excerpt=(p,beats)=>P.edited(p,x=>{x.lengthBeats=beats;for(const t of x.tracks)t.events=t.events.filter(e=>e.beat<beats).map(e=>e.type==='on'?{...e,dur:Math.min(e.dur,beats-e.beat)}:e.beats!==undefined?{...e,beats:Math.min(e.beats,beats-e.beat)}:e);});
const data=r=>{assert.notEqual(r.isError,true,JSON.stringify(r).slice(0,400));return r.structuredContent?.data||JSON.parse(r.content[0].text).data;};
const NEW=['search_presets','step_preset','import_preset','export_preset','manage_library','get_parameter_help','compare_patches','get_song_info','get_tour_info'];
test('preset browser search, chips, tags and stepping follow the website matching rules',()=>{
  const all=L.searchPresets({});assert.equal(all.total,100);assert.equal(all.counts.all,100);assert.equal(all.counts.pad,10);
  const warm=L.searchPresets({query:'warm pad'});assert.ok(warm.total>0);assert.ok(warm.presets.every(p=>`${p.name} ${p.description} ${p.tags.join(' ')} pad 鋪底`.toLowerCase().includes('warm')));
  const tag=all.tags[0],tagged=L.searchPresets({tag});assert.ok(tagged.presets.every(p=>p.tags.includes(tag)));
  const pads=L.searchPresets({category:'pad'}).presets,first=L.stepPreset({name:pads.at(-1).name,category:'pad'});assert.equal(first.preset.name,pads[0].name);
  assert.equal(L.stepPreset({name:pads[0].name,category:'pad',direction:-1}).preset.name,pads.at(-1).name);
  assert.throws(()=>L.searchPresets({category:'nope'}),/category/);
});
test('preset export/import round-trips through the website importer and client-owned library',()=>{
  const patch=P.patchFromPreset('Aurora Pad'),file=L.exportPreset(patch);assert.equal(file.format,'aurora-preset');assert.equal(file.macros.length,4);
  const again=L.importPresets(file).presets[0];assert.deepEqual(again.preset.params,parsePresetFile(file).presets[0].params);P.validatePatch(again.patch);
  const dirty=L.importPresets({name:'X',params:{'filter.cutoff':999999,'fake.id':1,'global.bpm':90}});assert.equal(dirty.presets[0].patch.params['filter.cutoff'],20000);assert.ok(dirty.warnings.some(w=>/fake\.id/.test(w)));assert.equal(dirty.presets[0].patch.params['global.bpm'],undefined);
  assert.throws(()=>L.importPresets({nothing:true}),/No preset/);
  let lib=L.manageLibrary({action:'save',patch}).library;lib=L.manageLibrary({library:lib,action:'save',patch}).library;assert.deepEqual(lib.presets.map(p=>p.name),['Aurora Pad','Aurora Pad (2)']);
  lib=L.manageLibrary({library:lib,action:'toggle_favourite',name:'Aurora Pad (2)'}).library;assert.deepEqual(lib.favourites,['u:Aurora Pad (2)']);
  assert.equal(L.searchPresets({library:lib,category:'fav'}).total,1);assert.equal(L.userPatch(lib,'Aurora Pad (2)').params['filter.cutoff'],patch.params['filter.cutoff']);
  lib=L.manageLibrary({library:lib,action:'delete',name:'Aurora Pad (2)'}).library;assert.deepEqual(lib.favourites,[]);assert.equal(lib.presets.length,1);
  assert.equal(L.manageLibrary({library:{presets:[{name:'',params:{}},{name:'ok',params:{},tags:'a, b'}]},action:'list'}).presets[0].tags.join(),'a,b');
});
test('parameter help, A/B comparison, song and tour info expose website text',()=>{
  const h=L.parameterHelp({ids:['filter.cutoff'],values:{'filter.cutoff':1200}}).parameters[0];assert.ok(h.help.zh&&h.help.en);assert.equal(h.formatted,'1.20 kHz');
  assert.equal(L.parameterHelp({}).parameters.length,P.parameterSchema().length);assert.ok(L.parameterHelp({group:'reverb'}).parameters.every(p=>p.id.startsWith('reverb.')));
  const cmp=L.comparePatches(P.patchFromPreset('Aurora Pad'),P.patchFromPreset('Velvet Dusk'));assert.ok(cmp.changed>0);assert.ok(cmp.summary.length>0);assert.equal(L.comparePatches(P.patchFromPreset('Aurora Pad'),P.patchFromPreset('Aurora Pad')).changed,0);
  for(const s of C.catalog().songs){const i=L.songInfo(s.id);assert.ok(i.sections.length>0&&i.parts.length>1);assert.equal(i.sections.reduce((a,x)=>a+x.beats,0),i.lengthBeats);}
  for(const t of C.catalog().tours){const i=L.tourInfo(t.id);assert.ok(i.steps.some(s=>s.caption?.zh&&s.caption?.en));}
  const d=L.catalogDetails();assert.equal(Object.keys(d.presetTags).length,100);assert.ok(d.phrases.every(p=>p.id&&p.label));assert.ok(d.moodExamples.length>0);assert.ok(d.chords.includes('maj7'));
});
test('Jam options, website evolve, demo macro rides and patch morph stay valid and reproducible',()=>{
  const base=C.jamReport({style:'lofi'}),next=C.jamReport({style:'lofi',variation:1});assert.equal(base.check.ok,true);assert.notDeepEqual(base.project.tracks.map(t=>t.events),next.project.tracks.map(t=>t.events));
  assert.deepEqual(C.jamProject({style:'ambient'}),C.jamReport({style:'ambient'}).project);
  const slim=C.jamReport({style:'synthwave',drums:false,backing:{pad:null,extra:null}});assert.ok(slim.project.tracks.length<base.project.tracks.length||slim.project.tracks.length===2);Project.parse(slim.project);
  assert.throws(()=>C.jamReport({backing:{bass:'No Such Preset'}}),/Unknown preset/);
  const p=P.createProject({patch:P.patchFromPreset('Aurora Pad')}),demo=C.applyPhrase(p,'auto',0,{macroRides:true});assert.ok(demo.tracks[0].events.some(e=>e.type==='ramp-macro'));Project.parse(demo);
  const evo=C.evolveWebsiteProject(demo,{groups:{macros:true,timbre:true,space:true},steps:16});Project.parse(evo);assert.deepEqual(evo,C.evolveWebsiteProject(demo,{groups:{macros:true,timbre:true,space:true},steps:16}));
  const targets=panelTargets({...P.parameterSchema().reduce((o,s)=>(o[s.id]=s.def,o),{}),...demo.tracks[0].patch.params},demo.tracks[0].patch.macros,{macros:true,timbre:true,space:true});
  const ids=new Set(evo.tracks[0].events.filter(e=>e.type==='param').map(e=>e.id));assert.ok(targets.filter(t=>!t.id.startsWith('macro')).every(t=>ids.has(t.id)));assert.ok(Math.abs(panelNoise(0.37,7))<=1);
  assert.equal(C.morphProject(p,P.patchFromPreset('Velvet Dusk'),1).tracks[0].patch.params['filter.cutoff'],C.morphProject(p,'Velvet Dusk',1).tracks[0].patch.params['filter.cutoff']);
});
test('official SDK client discovers and invokes every website-parity tool and extended option',async()=>{
  const app=await startHttp({port:0}),client=new Client({name:'aurora-parity',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url+'/mcp')));
    const names=(await client.listTools()).tools.map(t=>t.name);for(const n of NEW)assert.ok(names.includes(n),n);
    const call=(name,args)=>client.callTool({name,arguments:args}).then(data);
    assert.ok((await call('search_presets',{query:'bass'})).total>0);
    assert.equal((await call('step_preset',{name:'Aurora Pad'})).of,100);
    const project=(await call('create_project',{patch:(await call('get_preset',{name:'Aurora Pad'})).patch})).project;
    const file=(await call('export_preset',{project,tags:['mcp']})).preset;assert.deepEqual(file.tags,['mcp']);
    const imported=await call('import_preset',{data:file,project});assert.equal(imported.project.revision,1);
    const lib=(await call('manage_library',{action:'save',preset:file,name:'Mine'})).library;assert.equal((await call('get_preset',{name:'Mine',library:lib})).patch.name,'Mine');
    assert.equal((await call('get_parameter_help',{ids:['reverb.mix'],project})).parameters.length,1);
    assert.ok((await call('compare_patches',{a:'Aurora Pad',b:file.name==='Aurora Pad'?'Velvet Dusk':file.name})).changed>0);
    assert.ok((await call('get_song_info',{id:'neon-nights'})).sections.length>0);
    assert.ok((await call('get_tour_info',{id:'supersaw-pad'})).steps.length>0);
    assert.ok((await call('get_catalog',{})).details.styleDefaults.lofi);
    const mood=await call('apply_mood',{project,moods:['darker']});assert.ok(mood.changes.length>0&&mood.changes.every(c=>c.zh&&c.en));
    assert.ok((await call('apply_phrase',{project,macroRides:true})).project.tracks[0].events.some(e=>e.type==='ramp-macro'));
    assert.ok((await call('evolve_sound',{project,algorithm:'website',speed:0.8})).project.tracks[0].events.length>0);
    assert.equal((await call('morph_patch',{project,patch:(await call('get_preset',{name:'Velvet Dusk'})).patch,position:0.5})).project.revision,1);
    const jam=await call('generate_jam',{style:'house',variation:2,drums:true,backing:{extra:null}});assert.equal(typeof jam.check.ok,'boolean');Project.parse(jam.project);
    const bad=await client.callTool({name:'morph_patch',arguments:{project,position:0.5}});assert.equal(bad.isError,true);
  }finally{await client.close();await app.close();}
});
test('params automation events reach the renderer in single- and multi-track projects (tour timelines were silent)',()=>{
  const p=excerpt(C.loadTour('supersaw-pad','timeline'),16),strip=x=>P.edited(x,y=>{for(const t of y.tracks)t.events=t.events.filter(e=>e.type!=='params');});
  const asParam=P.edited(p,y=>{y.tracks[0].events=y.tracks[0].events.flatMap(e=>e.type==='params'?Object.entries(e.values).map(([id,value])=>({beat:e.beat,type:'param',id,value})):[e]);});
  assert.ok(p.tracks[0].events.some(e=>e.type==='params'));assert.notEqual(audioHash(p),audioHash(strip(p)));assert.equal(audioHash(p),audioHash(asParam));
  const multi=P.addTrack(p,{...structuredClone(p.tracks[0]),name:'Dup',events:[]});assert.notEqual(audioHash(multi),audioHash(strip(multi)));
});
test('auto-morph, freeze, random B, random category and theater follow the website panels',()=>{
  // applyPhrase sets the phrase tempo; pin 100 BPM so a 6 s period peaks exactly on beat 5
  let p=P.setParameters(excerpt(C.applyPhrase(P.createProject({patch:P.patchFromPreset('Aurora Pad')}),'pad'),16),{'global.bpm':100});
  const eff=patch=>effectiveValues(presetValues(patch),patch.macros);
  const differ=(x,y)=>PATCH_IDS.filter(id=>!/^macro/.test(id)).filter(id=>{const q=PARAM_BY_ID[id];return q.type==='enum'||q.type==='bool'?x[id]!==y[id]:Math.abs(toNorm(q,x[id])-toNorm(q,y[id]))>0.01;});
  assert.equal(C.randomPreset(7,['Aurora Pad']),C.randomPreset(7,['Aurora Pad']));assert.notEqual(C.randomPreset(7,['Aurora Pad']),'Aurora Pad');
  for(const b of ['Velvet Dusk','Solar Brass','Moonlit Suitcase']){
    const m=C.autoMorphProject(p,P.patchFromPreset(b),{period:6,steps:20,endBeat:16});Project.parse(m);assert.notEqual(audioHash(m),audioHash(p));
    assert.deepEqual(differ(eff(C.freezeProject(m,{beat:5}).tracks[0].patch),eff(C.morphProject(p,b,1).tracks[0].patch)),[]);
    assert.deepEqual(differ(eff(C.freezeProject(m,{beat:2.5}).tracks[0].patch),eff(C.morphProject(p,b,0.5-0.5*Math.cos(Math.PI/2)).tracks[0].patch)),[]);
    assert.equal(C.freezeProject(m,{beat:5}).tracks[0].events.filter(e=>e.type!=='on').length,0);
  }
  let r=P.setParameters(p,{'filter.cutoff':1000});r=P.edited(r,x=>x.tracks[0].events.push({beat:0,type:'ramp',id:'filter.cutoff',to:8000,beats:8},{beat:6,type:'param',id:'filter.res',value:0.5}));
  assert.ok(Math.abs(C.freezeProject(r,{beat:4}).tracks[0].patch.params['filter.cutoff']-Math.sqrt(1000*8000))<2);assert.equal(C.freezeProject(r,{beat:7}).tracks[0].patch.params['filter.res'],0.5);
  const cut=P.edited(r,x=>x.tracks[0].events.push({beat:2,type:'param',id:'filter.cutoff',value:500}));assert.equal(C.freezeProject(cut,{beat:4}).tracks[0].patch.params['filter.cutoff'],500);
  assert.equal(C.mutateProject(p,{random:true,seed:3,category:'bass'}).tracks[0].patch.category,'bass');assert.equal(C.mutateProject(p,{random:true,seed:3}).tracks[0].patch.category,'pad');
  assert.throws(()=>C.mutateProject(p,{random:true,category:'drum'}),/category/);
  const prog=C.theaterProgram({source:'pad'});assert.equal(prog.items.length,10);assert.ok(prog.items.every(i=>i.seconds>=10&&i.passes>=1));
  assert.deepEqual(C.theaterProgram({source:'all',shuffle:true,seed:9}).items.map(i=>i.name),C.theaterProgram({source:'all',shuffle:true,seed:9}).items.map(i=>i.name));
  assert.equal(C.theaterProgram({source:'songs'}).items.length,6);assert.throws(()=>C.theaterMedley({source:'songs'}),/songs/);
  const med=C.theaterMedley({source:'bell'});Project.parse(med.project);assert.ok(med.project.tracks.length>=2&&med.project.lengthBeats*60/120<=178);
  assert.ok(med.project.tracks.every(t=>t.events.some(e=>e.type==='ramp'&&e.id==='amp.level'&&e.to===-36)));
});
test('studio browser render budget scales with planned audio length and the Node watchdog is configurable',async()=>{
  const p=P.createProject({axes:{rhythm:{bpm:96}}}),at=beats=>P.browserRenderBudget({...p,lengthBeats:beats},{tailSeconds:4});
  assert.equal(at(4),60);assert.equal(at(280),537);assert.equal(P.browserRenderBudget({...p,lengthBeats:288},{tailSeconds:8}),564);assert.ok(at(280)*1000>60000);
  const src=await import('node:fs/promises').then(f=>f.readFile(new URL('../../src/creation/studio.js',import.meta.url),'utf8'));assert.ok(!/,60000\)/.test(src)&&/browserRenderBudget\(project,options\)/.test(src));
  const { renderTimeoutFromEnv, artifactBudgetFromEnv, nodeAdapter }=await import('../node-adapter.mjs');assert.equal(renderTimeoutFromEnv({}),60000);assert.equal(renderTimeoutFromEnv({AURORA_RENDER_TIMEOUT_MS:'600000'}),600000);assert.throws(()=>renderTimeoutFromEnv({AURORA_RENDER_TIMEOUT_MS:'10'}),/1000/);
  assert.equal(artifactBudgetFromEnv({}),100000000);assert.equal(artifactBudgetFromEnv({AURORA_ARTIFACT_BUDGET_BYTES:'500000000'}),500000000);
  for(const bad of ['1000','150000000.5','20000000000','abc'])assert.throws(()=>artifactBudgetFromEnv({AURORA_ARTIFACT_BUDGET_BYTES:bad}),/60000000/);
  const tiny=nodeAdapter({maxBytes:1000});try{await assert.rejects(tiny.render(C.designSfx({type:'ui',seconds:0.2}),{sampleRate:16000,tailSeconds:0}),e=>e.code==='STORAGE_LIMIT'&&/1 MB|0 MB/.test(e.message));}finally{await tiny.close();}
});
test('official SDK client invokes auto_morph, freeze_sound, theater_program and the random options',async()=>{
  const app=await startHttp({port:0}),client=new Client({name:'aurora-parity-2',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url+'/mcp')));
    const call=(name,args)=>client.callTool({name,arguments:args}).then(data);
    for(const n of ['auto_morph','freeze_sound','theater_program'])assert.ok((await client.listTools()).tools.some(t=>t.name===n),n);
    const project=excerpt(C.applyPhrase(P.createProject({patch:P.patchFromPreset('Aurora Pad')}),'pad'),8);
    const rb=await call('morph_patch',{project,random:true,seed:11,position:0.4});assert.ok(rb.b&&rb.b!=='Aurora Pad');
    const am=await call('auto_morph',{project,random:true,seed:11,period:4});assert.equal(am.b,rb.b);assert.ok(am.project.tracks[0].events.some(e=>e.type==='params'));
    const fr=await call('freeze_sound',{project:am.project,beat:4});assert.equal(fr.project.tracks[0].events.filter(e=>e.type!=='on').length,0);
    assert.equal((await call('mutate_patch',{project,random:true,category:'any',seed:5})).project.revision,project.revision+1);
    assert.equal((await call('theater_program',{source:'lead'})).items.length,10);
    const med=await call('theater_program',{source:'pluck',medley:true,count:3});assert.equal(med.project.tracks.length,3);
    assert.equal((await client.callTool({name:'auto_morph',arguments:{project,preset:'Velvet Dusk',random:true}})).isError,true);
  }finally{await client.close();await app.close();}
});
