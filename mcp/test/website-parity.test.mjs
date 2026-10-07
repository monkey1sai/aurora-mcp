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
