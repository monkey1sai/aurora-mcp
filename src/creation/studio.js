import { AXES, copy, createProject, validateProject, setParameters, axesWithDefaults, edited } from './project.js';
import { compose, designSfx, jamProject, catalog, moodProject, morphProject, mutateProject, evolveProject, loadSong, loadTour } from './compose.js';
const $ = id => document.getElementById(id), C = catalog(), history = [], future = [];
let project = compose(createProject({ title: $('title').value })), committed = copy(project), wav = null, metrics = null, worker = null, context = null, source = null, renderId = 0, room = null, pollTimer = null, renderCancel = null, playEpoch = 0, commandEpoch = 0;
const status = message => { $('status').textContent = message; };
const opt = (el, value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; el.append(o); };
for (const x of C.sfx) opt($('recipe'), x, { impact:'撞擊',whoosh:'掠過／轉場',riser:'上升蓄力',downer:'下降消散',ambience:'環境氛圍',ui:'介面提示',alarm:'警報',footstep:'腳步',laser:'雷射' }[x]);
for (const x of C.styles) opt($('style'), x, x);
for (const x of C.moods) opt($('mood'), x.id, x.zh);
for (const x of C.presets) opt($('morph-target'), x.name, x.name);
for (const x of C.songs) opt($('song'), x.id, x.title);
for (const x of C.tours) opt($('tour'), x.id, x.title);
const fields = {
  motive: [['intervals','動機音程（半音）','text'],['durations','節奏時值（拍）','text'],['development','發展方式',['repeat','transpose','invert','augment','fragment']],['transpose','每次移調（半音）','number',-12,12,1]],
  rhythm: [['bpm','速度 BPM','number',40,240,1],['bars','小節數','number',1,16,1],['density','密度','range',0,1,.01],['rest','休止比例','range',0,1,.01],['swing','切分／搖擺','range',0,.6,.01],['tension','重音張力','range',0,1,.01]],
  harmony: [['root','調性', ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B']],['scale','音階',C.scales.filter(s=>s!=='off')],['octave','音域（八度）','number',1,7,1],['progression','和聲級數','text'],['atonal','非調性（音效）',['false','true']]],
  expression: [['start','起始力度','range',0,1,.01],['end','結束力度','range',0,1,.01],['articulation','奏法／音長','range',.05,1,.01],['humanize','力度變化','range',0,1,.01]],
  timbre: [['preset','基礎音色',C.presets.map(p=>p.name)],['brightness','明暗','range',0,1,.01],['attack','起音（秒）','number',.001,5,.001],['release','釋放（秒）','number',.01,8,.01],['space','殘響空間','range',0,1,.01],['width','立體寬度','range',0,1,.01]],
};
const summaries = { motive:'讓一個短句，成為可辨認的主題。',rhythm:'快慢之外，還有呼吸、重音與推進。',harmony:'為聲音選一個落腳之處。',expression:'每一次起音，都有不同的重量。',timbre:'材質與距離，塑造場景的輪廓。' };
let count = 0;
for (const [axis, list] of Object.entries(fields)) {
  const section = document.createElement('article'); section.className='axis';
  const no = document.createElement('span'); no.className='number'; no.textContent=String(++count).padStart(2,'0');
  const title=document.createElement('h3');title.textContent=AXES[axis].zh; const desc=document.createElement('p');desc.textContent=summaries[axis];section.append(no,title,desc);
  for(const [key,label,type,min,max,step] of list) {
    const l=document.createElement('label');l.textContent=label;let el;
    if(Array.isArray(type)){el=document.createElement('select');type.forEach((v,i)=>opt(el,axis==='harmony'&&key==='root'?i:v,v));}
    else{el=document.createElement('input');el.type=type;if(min!==undefined){el.min=min;el.max=max;el.step=step;}}
    el.id=axis+'-'+key;l.append(el);section.append(l);
  }
  $('axes').append(section);
}
function readAxes() {
  const a={};
  for(const [axis,list] of Object.entries(fields)){a[axis]={};for(const [key,,type] of list){let v=$(axis+'-'+key).value;if(['intervals','durations','progression'].includes(key))v=v.split(',').map(x=>Number(x.trim()));else if(key==='atonal')v=v==='true';else if(!Array.isArray(type)||key==='root')v=Number(v);a[axis][key]=v;}}
  return axesWithDefaults(a);
}
function sync() {
  $('project-title').textContent=project.title;$('project-meta').textContent=project.tracks.length+' 聲部 / '+(project.lengthBeats*60/project.globals['global.bpm']).toFixed(1)+' 秒 / v'+project.revision;
  $('project-json').value=JSON.stringify(project,null,2);$('title').value=project.title;$('seed').value=project.seed;
  for(const [axis,list] of Object.entries(fields))for(const [key]of list){const v=project.axes[axis][key];$(axis+'-'+key).value=Array.isArray(v)?v.join(', '):String(v);}
  $('undo').disabled=!history.length;$('redo').disabled=!future.length;draw();
}
function replace(p, save=true) {
  validateProject(p);stop();cancel(false);if(save){history.push(copy(project));if(history.length>16)history.shift();future.length=0;}
  if(p.kind!==project.kind)$('kind').value=p.kind;
  project=copy(p);$('recipe-label').hidden=$('kind').value!=='sfx';$('style-label').hidden=$('kind').value!=='jam';wav=null;metrics=null;$('download-wav').disabled=true;$('metrics').textContent='';sync();
}
function make() {
  const axes=readAxes(), seed=Number($('seed').value), title=$('title').value, kind=$('kind').value;
  let p;
  if(kind==='sfx')p=designSfx({type:$('recipe').value,seconds:Number($('seconds').value),axes,seed,title});
  else if(kind==='jam')p=jamProject({style:$('style').value,axes,seed,title});
  else {p=createProject({title,kind,axes,seed}); if(kind==='sound'){p.lengthBeats=4;p.tracks[0].events=[{beat:0,type:'on',note:(axes.harmony.octave+1)*12+axes.harmony.root,vel:Math.max(.01,axes.expression.end),dur:2}];}else p=compose(p);}
  replace(p);status('作品已建立。可預聽、繼續雕刻，或下載專案。');return p;
}
function draw() {
  const canvas=$('score'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.strokeStyle='#304346';ctx.lineWidth=1;
  for(let y=32;y<h;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  for(let b=0;b<=project.lengthBeats;b+=4){const x=b/project.lengthBeats*w;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  project.tracks.forEach((t,index)=>t.events.filter(e=>e.type==='on').forEach(e=>{ctx.fillStyle=index%2?'#89c8bc':'#e4bb78';ctx.globalAlpha=.3+.7*e.vel;const x=e.beat/project.lengthBeats*w,y=h-20-(e.note-24)/84*(h-40);ctx.fillRect(x,Math.max(12,Math.min(h-12,y)),Math.max(3,e.dur/project.lengthBeats*w-1),5);}));ctx.globalAlpha=1;
}
async function enableAudio() { context??=new AudioContext();await context.resume();if(context.state!=='running')throw new Error('請先按預聽，以啟用瀏覽器音訊。'); }
function stop(){playEpoch++;if(source){try{source.stop();}catch{}source=null;}}
function cancel(announce=true){if(worker){worker.terminate();worker=null;renderId++;const cancelPromise=renderCancel;renderCancel=null;cancelPromise?.();$('cancel').disabled=true;if(announce)status('已取消渲染。');}}
function render(exactOptions) {
  cancel(false);const id=++renderId, options=exactOptions || {sampleRate:Number($('sample-rate').value),tailSeconds:Number($('tail').value),bitDepth:24};
  $('cancel').disabled=false;status('正在將 '+project.tracks.length+' 個聲部渲染成 WAV…');
  return new Promise((resolve,reject)=>{
    const w=new Worker(new URL('./render-worker.js',import.meta.url),{type:'module'});worker=w;
    const timer=setTimeout(()=>{if(worker===w){cancel(false);}},60000);
    renderCancel=()=>{clearTimeout(timer);reject(new Error('CANCELLED：渲染已取消或超過 60 秒預算。'));};
    w.onmessage=ev=>{if(id!==renderId)return;clearTimeout(timer);renderCancel=null;w.terminate();worker=null;$('cancel').disabled=true;const r=ev.data;if(r.status==='error'){reject(new Error(r.code+': '+r.message));return;}wav=r.wav;metrics=r.metrics;$('download-wav').disabled=false;$('metrics').textContent=JSON.stringify(metrics,null,2);status('WAV 已完成：'+metrics.seconds.toFixed(2)+' 秒。'+metrics.warnings.join(' · '));resolve(r);};
    w.onerror=e=>{clearTimeout(timer);renderCancel=null;w.terminate();worker=null;$('cancel').disabled=true;reject(new Error(e.message));};w.postMessage({id,project,options});
  });
}
async function play(allowed=()=>true){if(!allowed())throw new Error('CANCELLED：AI 控制已撤銷。');if(!wav)await render();stop();const epoch=playEpoch;const buffer=await context.decodeAudioData(wav.slice(0));if(epoch!==playEpoch||!allowed())throw new Error('CANCELLED：播放已停止或 AI 控制已撤銷。');source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.start();status('正在播放。音訊已完成渲染；可直接下載 WAV。');}
function download(bytes,type,name){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const safeName=()=>project.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g,'_').slice(0,60)||'aurora';
function action(id,fn){$(id).addEventListener('click',async()=>{try{await fn();}catch(e){status(e.message);}});}
action('create',make);action('preview',async()=>{await enableAudio();if(!wav)await render();await play();});action('stop',()=>{stop();cancel(false);status('已停止播放。');});action('cancel',()=>cancel());
action('download-wav',()=>{if(wav)download(wav,'audio/wav',safeName()+'.wav');});action('download-project',()=>download(JSON.stringify(project,null,2),'application/json',safeName()+'.aurora.json'));action('download-preset',()=>download(JSON.stringify(project.tracks[0].patch,null,2),'application/json',safeName()+'.preset.json'));
action('open-synth',()=>{sessionStorage.setItem('aurora.mcp.toSynth',JSON.stringify({patch:project.tracks[0].patch,globals:project.globals}));location.href='index.html';});
action('apply-mood',()=>{replace(moodProject(project,[$('mood').value]));status('已套用魔法調音。');});action('morph',()=>{replace(morphProject(project,$('morph-target').value,Number($('morph-position').value)));status('已套用音色變形。');});
action('mutate',()=>{replace(mutateProject(project));status('已保留一次微調變異。');});action('random',()=>{replace(mutateProject(project,{random:true}));status('已生成隨機音色。');});action('evolve',()=>{replace(evolveProject(project));status('已加入可重現的參數演化。');});
action('load-song',()=>{replace(loadSong($('song').value,$('song-length').value==='full'?undefined:Number($('song-length').value)));status('已載入多聲部編曲，可編輯、預聽及匯出。');});
action('load-tour',()=>{replace(loadTour($('tour').value));status('已取得導覽的最終音色。');});action('load-tour-timeline',()=>{replace(loadTour($('tour').value,'timeline'));status('已載入導覽的完整音色變化。');});
action('undo',()=>{if(history.length){future.push(copy(project));replace(history.pop(),false);status('已回到上一步。');}});action('redo',()=>{if(future.length){history.push(copy(project));replace(future.pop(),false);status('已重做。');}});action('commit',()=>{committed=copy(project);status('已保留目前版本。');});action('revert',()=>{replace(committed);status('已還原保留版本。');});
action('apply-json',()=>{replace(JSON.parse($('project-json').value));status('專案驗證通過，已套用。');});
$('import').addEventListener('change',async ev=>{try{const f=ev.target.files[0];if(!f)return;if(f.size>1500000)throw new Error('專案檔超過 1.5 MB。');const data=JSON.parse(await f.text());replace(data.project||data);status('專案已匯入。');}catch(e){status(e.message);}ev.target.value='';});
$('morph-position').addEventListener('input',()=>{$('morph-value').value=Number($('morph-position').value).toFixed(2);});
for(const id of ['sample-rate','tail'])$(id).addEventListener('change',()=>{stop();cancel(false);wav=null;metrics=null;$('download-wav').disabled=true;$('metrics').textContent='';status('輸出設定已變更，請重新生成並預聽。');});
$('kind').addEventListener('change',()=>{$('recipe-label').hidden=$('kind').value!=='sfx';$('style-label').hidden=$('kind').value!=='jam';});
async function request(url,method='GET',data){const r=await fetch(url,{method,headers:data?{'content-type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const value=await r.json();if(!r.ok)throw new Error(value.message||value.error||'服務無法使用');return value;}
action('connect-browser',async()=>{await enableAudio();const result=await request('/rooms','POST');room=result.room;$('connect-browser').disabled=true;$('disconnect-browser').disabled=false;$('room-status').textContent='已啟用 30 分鐘。Room：'+room+'（僅本機 MCP 可控制）';pollTimer=setInterval(poll,750);});
async function poll() {
  if (!room) return;
  const id = room, epoch=commandEpoch;
  try {
    const { commands } = await request('/rooms/' + id);
    if(room!==id||epoch!==commandEpoch)return;
    for (const cmd of commands) {
      if(room!==id||epoch!==commandEpoch)return;
      let result;
      try {
        if (cmd.action === 'stop') { commandEpoch++;stop(); cancel(false); result = { status: 'stopped' }; }
        else {
          if (worker) throw new Error('RENDER_BUSY：先停止目前渲染，再套用另一個作品。');
          replace(cmd.project);
          if (cmd.action === 'play_project') {
            if (!context || context.state !== 'running') throw new Error('音訊尚未啟用，請按預聽。');
            await render(); await play(()=>room===id&&epoch===commandEpoch); result = { status: 'audio-running' };
          } else result = { status: 'project-applied' };
        }
      } catch (e) { result = { status: 'error', message: e.message }; }
      if (room === id) await request('/rooms/' + id + '/ack', 'POST', { requestId: cmd.requestId, ...result });
    }
  } catch (e) { $('room-status').textContent = e.message; await disconnect(); }
}
async function disconnect(){const id=room;room=null;clearInterval(pollTimer);pollTimer=null;stop();cancel(false);$('connect-browser').disabled=false;$('disconnect-browser').disabled=true;if(id)await request('/rooms/'+id,'DELETE').catch(()=>{});$('room-status').textContent='AI 控制已停用，播放已停止。';}
action('disconnect-browser',disconnect);
window.addEventListener('pagehide',()=>{stop();cancel(false);clearInterval(pollTimer);if(room)fetch('/rooms/'+room,{method:'DELETE',keepalive:true}).catch(()=>{});});
$('endpoint').value=location.origin+'/mcp';$('recipe-label').hidden=true;$('style-label').hidden=true;sync();
// Cloud jobs store a public, expiring composition. Rendering is explicitly performed by this browser.
const job=new URLSearchParams(location.search).get('job');
if(job){try{
  const data=await request('/jobs/'+encodeURIComponent(job));replace(data.project);
  $('sample-rate').value=data.options.sampleRate||24000;$('tail').value=data.options.tailSeconds??2;
  $('cloud-job').textContent='此作品由 MCP 建立。提供給 AI 時會使用原始作品及指定的輸出設定，包含位元深度；頁面上的後續修改請另外匯出。檔案公開且 1 小時後失效，請勿使用私人素材。';
  const button=document.createElement('button');button.textContent=data.status==='artifact-ready'?'音訊已提供給 AI':'渲染原始作品並提供下載給 AI';button.disabled=data.status==='artifact-ready';
  button.addEventListener('click',async()=>{button.disabled=true;try{
    await enableAudio();replace(data.project);await render(data.options);
    status('正在傳送已生成的 WAV…');
    const response=await fetch('/jobs/'+encodeURIComponent(job)+'/audio',{method:'PUT',headers:{'content-type':'audio/wav','x-aurora-metrics':btoa(JSON.stringify(metrics))},body:wav});
    if(!response.ok)throw new Error('WAV 上傳失敗：'+response.status);
    button.textContent='音訊已提供給 AI';status('音訊已提供給 AI，可下載使用。');
  }catch(e){button.disabled=false;status(e.message);}});$('cloud-job').after(button);
}catch(e){status(e.message);}}
else try{const raw=sessionStorage.getItem('aurora.mcp.fromSynth');if(raw){sessionStorage.removeItem('aurora.mcp.fromSynth');const value=JSON.parse(raw);const p=createProject({title:value.patch.name||'合成器音色',kind:'sound',patch:value.patch});p.lengthBeats=4;p.tracks[0].events=[{beat:0,type:'on',note:60,vel:.8,dur:2}];replace(setParameters(p,value.globals||{}));committed=copy(project);status('已從完整合成器匯入目前音色及全域設定。');}}catch(e){status(e.message);}
request('/health').then(health=>{if(health.render==='browser-worker'){$('connect-browser').disabled=true;$('room-status').textContent='公開服務提供作品與下載；即時瀏覽器控制請啟動本機 MCP 服務。';}}).catch(()=>{});
