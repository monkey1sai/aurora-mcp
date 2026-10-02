// Local-only runtime admission test: consumes at most 21 tiny job reservations.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const endpoint=process.argv[2];if(!endpoint||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('This quota probe is restricted to local workerd');
const client=new Client({name:'aurora-acceptance',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const r=await client.callTool({name:'design_sound_effect',arguments:{type:'ui',seconds:.1}});assert.notEqual(r.isError,true);
  const project=r.structuredContent.data.project;let accepted=0,denial;
  for(let i=0;i<21;i++){
    const result=await client.callTool({name:'render_audio',arguments:{project,options:{sampleRate:16000,tailSeconds:0,bitDepth:16}}});
    if(result.isError){denial=result.structuredContent.data.message;assert.match(denial,/DAILY_RENDER_BUDGET/);break;}assert.equal(result.structuredContent.status,'queued');accepted++;
  }
  assert.ok(denial,'Expected daily quota denial');assert.ok(accepted<=20);
  const evidence={endpoint,era:client.getProtocolEra(),newJobsAccepted:accepted,denial,mode:'actual local workerd admission; no audio render or remote write'};
  if(process.argv[3])await fs.writeFile(process.argv[3],JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await client.close();}
