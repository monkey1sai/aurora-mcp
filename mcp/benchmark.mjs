import fs from 'node:fs/promises';
import { nodeAdapter } from './node-adapter.mjs';
import { loadSong } from '../src/creation/compose.js';
const adapter=nodeAdapter();let peakRss=process.memoryUsage().rss;const timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);
try{const project=loadSong('neon-nights'),started=performance.now(),artifact=await adapter.render(project,{sampleRate:24000,tailSeconds:2,bitDepth:24});
const result={song:project.title,elapsedMs:performance.now()-started,peakProcessRssBytes:peakRss,artifact};if(process.argv[2])await fs.writeFile(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{clearInterval(timer);await adapter.close();}
