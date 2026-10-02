// Local browser acceptance helper. Requires a room explicitly enabled in Studio.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
const [endpoint,room,action='play_project']=process.argv.slice(2),url=new URL(endpoint);
if(url.hostname!=='127.0.0.1'||!room||!['play_project','stop'].includes(action))throw new Error('Use loopback endpoint, enabled room, and play_project|stop');
const client=new Client({name:'aurora-room-acceptance',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
const data=r=>{if(r.isError)throw new Error(JSON.stringify(r));return r.structuredContent?.data||JSON.parse(r.content[0].text).data;};
try{
 await client.connect(new StreamableHTTPClientTransport(url));
 const project=action==='play_project'?data(await client.callTool({name:'design_sound_effect',arguments:{type:'ui',seconds:.2,title:'AI room control acceptance'}})).project:undefined;
 const requestId=randomUUID();console.log(JSON.stringify(data(await client.callTool({name:'browser_command',arguments:{room,requestId,action,...(project?{project}:{})}})),null,2));
}finally{await client.close();}
