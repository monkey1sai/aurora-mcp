import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const [endpoint,id,prefix]=process.argv.slice(2);if(!endpoint||!id)throw new Error('Supply authorized MCP endpoint and job ID');
const client=new Client({name:'aurora-acceptance',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});let data;
try{await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));const r=await client.callTool({name:'get_render_result',arguments:{id}});assert.notEqual(r.isError,true);assert.equal(r.structuredContent.status,'artifact-ready');data=r.structuredContent.data;}finally{await client.close();}
const response=await fetch(data.downloadUrl);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,data.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),data.sha256);assert.equal(bytes.toString('ascii',0,4),'RIFF');
const duplicate=await fetch(data.downloadUrl,{method:'PUT'});assert.equal(duplicate.status,409);
if(prefix){await fs.writeFile(prefix+'.wav',bytes);await fs.writeFile(prefix+'.json',JSON.stringify({...data,evidence:'SDK result + downloaded byte hash; browser performed render; local workerd only',replacementStatus:duplicate.status},null,2));}console.log(JSON.stringify({status:data.status,bytes:bytes.length,sha256:data.sha256,replacementStatus:duplicate.status},null,2));
