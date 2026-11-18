import { createServer } from "node:http";
import { createCodexHost } from "./codex-host.mjs";
import { createOpenClawHost } from "./openclaw-host.mjs";
import { createClaudeHost } from "./claude-host.mjs";
import { serveDemoFile } from "./serve-demo.mjs";

/** One selector page, with explicitly trusted same-app origins on private
 * child hosts. Provider ports and credentials are never user-supplied. */
export async function createAiHost({port=4184,cwd=process.cwd(),codex={},claude={},openclaw={}}={}) {
  let url;const providers=new Map();
  const server=createServer(async(req,res)=>{
    if(req.headers.host!==new URL(url).host||(req.headers.origin&&req.headers.origin!==url)){res.writeHead(403).end();return;}
    const path=new URL(req.url,url).pathname;
    const json=(status,value)=>res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify(value));
    if(path==="/api/providers"&&req.method==="GET"){
      json(200,[...providers].map(([id,entry])=>({id,name:entry.name})));return;
    }
    const match=path.match(/^\/api\/providers\/(codex|claude|openclaw)$/);
    if(match&&req.method==="GET"){
      const id=match[1],entry=providers.get(id);
      if(!entry){json(503,{ready:false,error:"AI host is starting."});return;}
      try{
        const status=await fetch(`${entry.host.url}/${id}/status`,{signal:AbortSignal.timeout(45000)});
        if(!status.ok)throw new Error("Could not read the selected AI status.");
        const metadata=await status.json();
        json(200,{...metadata,id,name:entry.name,wsUrl:`${entry.host.url.replace("http:","ws:")}/${id}`});
      }catch(error){json(200,{id,name:entry.name,ready:false,error:error.message});}
      return;
    }
    if(path==="/")req.url="/examples/browser/huddle.html";
    await serveDemoFile(req,res);
  });
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",done);});
  url=`http://127.0.0.1:${server.address().port}`;
  const close=async()=>{
    await Promise.allSettled([...providers.values()].map(entry=>entry.host.close()));
    await new Promise(done=>{server.close(done);server.closeAllConnections();});
  };
  try{
    providers.set("codex",{name:"Codex",host:await createCodexHost({...codex,cwd,port:0,allowedOrigins:[url]})});
    providers.set("claude",{name:"Claude",host:await createClaudeHost({...claude,cwd,port:0,allowedOrigins:[url]})});
    providers.set("openclaw",{name:"OpenClaw",host:await createOpenClawHost({...openclaw,cwd,port:0,allowedOrigins:[url]})});
    return{url,close};
  }catch(error){await close();throw error;}
}
