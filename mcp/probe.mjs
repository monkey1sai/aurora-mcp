// Bounded protocol probe; use only an explicitly authorized endpoint.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const url=process.argv[2];if(!url)throw new Error('Usage: node mcp/probe.mjs http://127.0.0.1:8789/mcp [jobId]');
const client=new Client({name:'aurora-acceptance',version:'1.0.0'},{versionNegotiation:{mode:process.env.AURORA_PROBE_MODE||'auto'}});
const data=r=>{if(r.isError)throw new Error(JSON.stringify(r));return r.structuredContent?.data||JSON.parse(r.content[0].text).data;};
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  if(process.argv[3])console.log(JSON.stringify(data(await client.callTool({name:'get_render_result',arguments:{id:process.argv[3]}})),null,2));
  else{
    const list=await client.listTools(),cap=data(await client.callTool({name:'get_capabilities',arguments:{}}));
    const project=data(await client.callTool({name:'design_sound_effect',arguments:{type:'whoosh',seconds:0.5,title:'MCP cloud whoosh',seed:42}})).project;
    const render=data(await client.callTool({name:'render_audio',arguments:{project,options:{sampleRate:24000,tailSeconds:0.25,bitDepth:24}}}));
    console.log(JSON.stringify({era:client.getProtocolEra(),tools:list.tools.length,renderMode:cap.render,render},null,2));
  }
}finally{await client.close();}
