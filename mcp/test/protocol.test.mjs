import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startHttp } from '../http.mjs';
import { ROOT, nodeAdapter } from '../node-adapter.mjs';
import { designSfx } from '../../src/creation/compose.js';
const data=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent?.data||JSON.parse(r.content[0].text).data;};
for(const mode of ['legacy','auto'])test('official SDK HTTP client '+mode+' discovers and invokes creation, render, resources, prompts and download',async()=>{
  const app=await startHttp({port:0}),client=new Client({name:'aurora-test',version:'1.0.0'},{versionNegotiation:{mode}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url+'/mcp')));
    const listed=await client.listTools();assert.ok(listed.tools.length>=28);assert.ok(listed.tools.every(t=>t.inputSchema&&t.outputSchema));
    const cap=data(await client.callTool({name:'get_capabilities',arguments:{}}));assert.equal(cap.render,'node-worker');
    const project=data(await client.callTool({name:'design_sound_effect',arguments:{type:'ui',seconds:0.2}})).project;
    const changed=data(await client.callTool({name:'set_parameters',arguments:{project,values:{'filter.cutoff':1200}}})).project;assert.equal(changed.revision,1);
    const artifact=data(await client.callTool({name:'render_audio',arguments:{project:changed,options:{sampleRate:16000,tailSeconds:0.1}}}));assert.equal(artifact.status,'artifact-ready');
    const response=await fetch(artifact.downloadUrl);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/wav');const wav=Buffer.from(await response.arrayBuffer());assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.length,artifact.bytes);
    const resource=await client.readResource({uri:artifact.resourceUri});assert.equal(resource.contents[0].mimeType,'audio/wav');
    const axes=await client.readResource({uri:'aurora://axes'});assert.equal(Object.keys(JSON.parse(axes.contents[0].text)).length,5);
    const prompts=await client.listPrompts();assert.ok(prompts.prompts.some(p=>p.name==='scene_sound'));
    const bad=await client.callTool({name:'set_parameters',arguments:{project,values:{'filter.cutoff':999999}}});assert.equal(bad.isError,true);
    const origin=await fetch(app.url+'/mcp',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});assert.equal(origin.status,403);
    for(const file of ['/.git/config','/mcp/stdio.mjs','/node_modules/zod/package.json','/renders/mcp/secret.wav'])assert.equal((await fetch(app.url+file)).status,404);
  }finally{await client.close();await app.close();}
});
test('official SDK stdio client completes handshake, composition and actual WAV resource read',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'mcp/stdio.mjs')],cwd:ROOT,stderr:'pipe'});
  const client=new Client({name:'aurora-stdio-test',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
  try{
    await client.connect(transport);const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='compose_music'));
    const project=data(await client.callTool({name:'design_sound_effect',arguments:{type:'impact',seconds:0.2}})).project;
    const a=data(await client.callTool({name:'render_audio',arguments:{project,options:{sampleRate:16000,tailSeconds:0.1}}}));
    const r=await client.readResource({uri:a.resourceUri});assert.equal(Buffer.from(r.contents[0].blob,'base64').toString('ascii',0,4),'RIFF');
  }finally{await client.close();await transport.close();}
});
test('worker watchdog and cancellation terminate rendering without claiming a ready artifact',async()=>{
  const a=nodeAdapter({timeoutMs:1});try{await assert.rejects(a.render(designSfx({type:'ambience',seconds:10}),{}),e=>e.code==='RENDER_TIMEOUT');}finally{await a.close();}
  const b=nodeAdapter(),abort=new AbortController();abort.abort();try{await assert.rejects(b.render(designSfx(),{},{signal:abort.signal}),e=>e.code==='CANCELLED');}finally{await b.close();}
});
