import { createServer } from "node:http";
import { createCodexHost } from "./codex-host.mjs";
import { createOpenClawHost } from "./openclaw-host.mjs";
import { createClaudeHost } from "./claude-host.mjs";
import { serveDemoFile } from "./serve-demo.mjs";
import { validateRemoteSettings } from "./openclaw-remote-backend.mjs";
import { createWireGuardHttps } from "./wireguard-https.mjs";

/** Provider hosts accept only the selector's origin. */
export async function createAiHost({port=4184,cwd=process.cwd(),codex={},claude={},openclaw={},openclawRemote={},remoteStore,wireguard}={}) {
  let url,remoteHost,remoteSettings,storageError,configuring=false,mutation,closing,vpnHost;
  const providers=new Map();
  const remoteOptions={...openclaw,...openclawRemote,backend:openclawRemote.backend,mode:"remote"};
  const startRemote=remote=>createOpenClawHost({...remoteOptions,remote,cwd,port:0,allowedOrigins:[url]});
  try{
    remoteSettings=await remoteStore?.load()??(remoteOptions.remote?.url?validateRemoteSettings(remoteOptions.remote):undefined);
  }catch{
    storageError="저장된 OpenClaw 인증을 읽을 수 없습니다. 새 인증 정보를 입력하거나 저장된 인증을 삭제해 주세요.";
  }

  async function replaceRemote(settings) {
    const previous=remoteHost;
    const resume=previous?.pauseIfIdle();
    if(previous&&!resume)return false;
    let next;
    try{
      if(settings)next=await startRemote(settings);
      if(settings)await remoteStore?.save(settings);
      else await remoteStore?.remove();
    }catch(error){
      resume?.();
      await next?.close();
      throw error;
    }
    remoteHost=next;
    remoteSettings=settings;
    storageError=undefined;
    await previous?.close();
    return true;
  }

  async function handleRequest(req,res,origin,vpn=false){
    if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return;}
    const requestUrl=new URL(req.url,origin),path=requestUrl.pathname;
    const json=(status,value)=>res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"}).end(JSON.stringify(value));
    if(path==="/api/providers/openclaw/remote/reveal"){
      if(vpn){json(403,{error:"저장된 인증은 이 Mac의 로컬 Huddle에서 확인할 수 있습니다."});return;}
      if(req.method!=="POST"){json(405,{error:"Method not allowed."});return;}
      if(req.headers.origin!==url||req.headers["content-type"]!=="application/json"){
        json(403,{error:"Same-origin settings request required."});return;
      }
      if(configuring||remoteHost?.busy){json(409,{error:"통화나 설정 변경을 마친 뒤 인증 정보를 확인해 주세요."});return;}
      if(!remoteSettings){json(404,{error:"저장된 인증 정보가 없습니다."});return;}
      const authType=remoteSettings.token?"token":"password";
      json(200,{url:remoteSettings.url,authType,secret:remoteSettings[authType]});return;
    }
    if(path==="/api/providers/openclaw/remote"){
      if(req.method==="GET"){
        json(200,{url:remoteSettings?.url??"",agent:remoteSettings?.agent??"",configured:!!remoteSettings,hasCredentials:!!(remoteSettings?.token||remoteSettings?.password),authType:remoteSettings?remoteSettings.token?"token":"password":null,...(storageError?{storageError}:{})});return;
      }
      if(vpn){json(403,{error:"저장된 인증은 이 Mac의 로컬 Huddle에서 변경할 수 있습니다."});return;}
      if(!["POST","DELETE"].includes(req.method)){json(405,{error:"Method not allowed."});return;}
      if(req.headers.origin!==url||(req.method==="POST"&&req.headers["content-type"]!=="application/json")){json(403,{error:"Same-origin settings request required."});return;}
      if(configuring||remoteHost?.busy){json(409,{error:"통화 종료 후 원격 설정을 변경해 주세요."});return;}
      configuring=true;
      try{
        let settings;
        if(req.method==="POST"){
          try{
            let bytes=0;const chunks=[];
            for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw new Error("원격 설정이 너무 큽니다.");chunks.push(chunk);}
            const submitted=JSON.parse(Buffer.concat(chunks).toString());
            if(submitted?.reuseSaved===true){
              const authType=remoteSettings?.token?"token":"password";
              if(!remoteSettings||submitted.authType!==authType||Object.keys(submitted).some(key=>!["url","agent","authType","reuseSaved"].includes(key)))
                throw new Error("저장된 인증 정보를 사용할 수 없습니다. 인증 정보를 다시 입력해 주세요.");
              settings=validateRemoteSettings({url:submitted.url,agent:submitted.agent,[authType]:remoteSettings[authType]});
              if(settings.url!==remoteSettings.url)throw new Error("Gateway 주소가 바뀌었습니다. 새 주소의 인증 정보를 입력해 주세요.");
            }else settings=validateRemoteSettings(submitted);
          }catch(error){json(400,{error:error instanceof SyntaxError?"원격 설정 형식을 확인해 주세요.":error.message});return;}
        }
        if(closing){json(503,{error:"Huddle 서버가 종료 중입니다."});return;}
        mutation=replaceRemote(settings);
        if(!await mutation){json(409,{error:"통화 종료 후 원격 설정을 변경해 주세요."});return;}
        json(200,{configured:!!settings});
      }catch{
        json(500,{error:req.method==="DELETE"?"저장된 인증 정보를 삭제하지 못했습니다. 로컬 저장소 권한을 확인해 주세요.":"원격 설정을 저장하지 못했습니다. 로컬 저장소 권한을 확인해 주세요."});
      }finally{configuring=false;mutation=undefined;}
      return;
    }
    if(path==="/api/providers"&&req.method==="GET"){
      json(200,[...providers].map(([id,entry])=>({id,name:entry.name})));return;
    }
    const match=path.match(/^\/api\/providers\/(codex|claude|openclaw)$/);
    if(match&&req.method==="GET"){
      const id=match[1],mode=requestUrl.searchParams.get("mode")??"local";
      if(id==="openclaw"&&!["local","remote"].includes(mode)){json(400,{error:"Unknown OpenClaw mode."});return;}
      const remote=id==="openclaw"&&mode==="remote";
      if(remote&&configuring){json(503,{ready:false,error:"원격 설정 적용 중입니다."});return;}
      if(remote&&!remoteSettings){
        json(200,{id,name:"OpenClaw",mode,ready:false,busy:false,error:storageError??"화면에서 원격 Gateway 주소와 인증 정보를 입력해 주세요."});return;
      }
      const entry=remote?{name:"OpenClaw",host:remoteHost}:providers.get(id);
      if(!entry?.host){json(503,{ready:false,error:"AI host is starting."});return;}
      try{
        const status=await fetch(`${entry.host.url}/${id}/status`,{signal:AbortSignal.timeout(remote?65000:45000)});
        if(!status.ok)throw new Error("Could not read the selected AI status.");
        const metadata=await status.json();
        const wsUrl=vpn?`${origin.replace("https:","wss:")}/voice/${remote?"openclaw-remote":id}`:`${entry.host.url.replace("http:","ws:")}/${id}`;
        json(200,{...metadata,...(id==="openclaw"?{mode}:{}),id,name:entry.name,wsUrl});
      }catch(error){json(200,{id,name:entry.name,ready:false,error:error.message});}
      return;
    }
    if(path==="/")req.url="/examples/browser/huddle.html";
    await serveDemoFile(req,res);
  }
  const server=createServer((req,res)=>handleRequest(req,res,url));
  function lookupVoice(route){
    const id=route?.match(/^\/voice\/(codex|claude|openclaw|openclaw-remote)$/)?.[1];
    if(!id||closing)return undefined;
    if(id==="openclaw-remote")return !configuring&&remoteHost?`${remoteHost.url}/openclaw`:undefined;
    const provider=providers.get(id);
    return provider?`${provider.host.url}/${id}`:undefined;
  }
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",done);});
  url=`http://127.0.0.1:${server.address().port}`;
  const close=()=>closing??=(async()=>{
    const closed=new Promise(done=>{server.close(done);server.closeAllConnections();});
    await vpnHost?.close();
    await mutation?.catch(()=>{});
    await Promise.allSettled([...providers.values()].map(entry=>entry.host.close()));
    await remoteHost?.close();
    await closed;
  })();
  try{
    providers.set("codex",{name:"Codex",host:await createCodexHost({...codex,cwd,port:0,allowedOrigins:[url]})});
    providers.set("claude",{name:"Claude",host:await createClaudeHost({...claude,cwd,port:0,allowedOrigins:[url]})});
    providers.set("openclaw",{name:"OpenClaw",host:await createOpenClawHost({...openclaw,cwd,port:0,allowedOrigins:[url]})});
    if(remoteSettings)remoteHost=await startRemote(remoteSettings);
    if(wireguard)vpnHost=await createWireGuardHttps({...wireguard,port:wireguard.port??server.address().port,origin:url,handle:handleRequest,lookupVoice});
    return{url,vpnUrl:vpnHost?.url,close};
  }catch(error){await close();throw error;}
}
