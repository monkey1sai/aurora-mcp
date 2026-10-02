// Explicit integration probe against a named local workerd or authorized cloud endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { renderProject, encodePcmWav } from '../src/creation/render.js';
const url=process.argv[2];if(!url)throw new Error('Supply the authorized MCP endpoint URL');
const output=process.argv[3];const results=[];
for(const mode of ['legacy','auto']){
  const client=new Client({name:'aurora-cloud-verification',version:'1.0.0'},{versionNegotiation:{mode}});
  const call=async(name,args={})=>{console.error(mode+': '+name);const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));assert.equal((await client.listTools()).tools.length,27);
    const project=(await call('design_sound_effect',{type:'laser',seconds:.2})).data.project,options={sampleRate:16000,tailSeconds:.1,bitDepth:16};
    const queued=await call('render_audio',{project,options});assert.equal(queued.status,'queued');
    const base=new URL(queued.data.renderUrl).origin,job=queued.data.id;
    const audio=renderProject(project,options),wav=encodePcmWav(audio.L,audio.R,16000,16);
    const uploaded=await fetch(base+'/jobs/'+job+'/audio',{method:'PUT',body:wav});assert.equal(uploaded.status,200,await uploaded.text());
    const duplicate=await fetch(base+'/jobs/'+job+'/audio',{method:'PUT',body:wav});assert.equal(duplicate.status,409,await duplicate.text());
    const ready=await call('get_render_result',{id:job});assert.equal(ready.status,'artifact-ready');
    const bytes=new Uint8Array(await(await fetch(ready.data.downloadUrl)).arrayBuffer());assert.deepEqual(bytes,wav);assert.equal(createHash('sha256').update(bytes).digest('hex'),ready.data.sha256);
    const rejected=await fetch(base+'/mcp',{method:'POST',headers:{origin:'https://foreign.example'},body:'{}'});assert.equal(rejected.status,403);
    assert.equal((await fetch(base+'/rooms',{method:'POST'})).status,403);
    results.push({mode,era:client.getProtocolEra(),tools:27,status:ready.status,bytes:bytes.length,sha256:ready.data.sha256});
  }finally{await client.close();}
}
if(output)await fs.writeFile(output,JSON.stringify({evidence:'HTTP integration; CLI-rendered upload, not browser or deployed-site acceptance',endpoint:url,results},null,2));
console.log(JSON.stringify(results,null,2));
