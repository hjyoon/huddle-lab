import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { serveDemoFile } from "./serve-demo.mjs";

/** A single local voice owner. Backends are injected for ASR/model/TTS testing. */
export async function createLocalVoiceHost({id,name,port=0,cwd=process.cwd(),backend,entry,allowedOrigins=[]}={}) {
  if(!/^[a-z][a-z0-9-]*$/.test(id)||typeof name!=="string"||!backend)throw new Error("An identified voice backend is required.");
  if(!isAbsolute(cwd)||!(await stat(cwd)).isDirectory())throw new Error("Choose an existing absolute workspace.");
  let url,active,checking,closingHost=false,paused=false,login;
  const inspect=()=>checking??=(async()=>{try{return await backend.inspect();}finally{checking=undefined;}})();
  const loginAbort=new AbortController();
  const startLogin=()=>login??=(async()=>{try{await backend.login(loginAbort.signal);}finally{login=undefined;}})();
  const server=createServer(async(req,res)=>{
    if(req.headers.host!==new URL(url).host||(req.headers.origin&&req.headers.origin!==url)){res.writeHead(403).end();return;}
    const path=new URL(req.url,url).pathname;
    if(path===`/${id}/status`&&req.method==="GET"){
      try{res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify({...await inspect(),busy:!!active,canLogin:!!backend.login}));}
      catch{res.writeHead(503).end();}return;
    }
    if(path===`/${id}/login`&&backend.login){
      const json=(status,value)=>res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify(value));
      if(req.method!=="POST"){json(405,{error:"Method not allowed."});return;}
      if(req.headers.origin){json(403,{error:"Login is requested through the selector host."});return;}
      if(active||closingHost){json(409,{error:"통화 종료 후 로그인해 주세요."});return;}
      try{await startLogin();json(200,{signedIn:true});}
      catch(error){json(closingHost?503:400,{error:String(error.message??error).slice(0,500)});}
      return;
    }
    if(path==="/"){if(!entry){res.writeHead(404).end();return;}req.url=`/examples/browser/${entry}`;}
    await serveDemoFile(req,res);
  });
  const ws=new WebSocketServer({noServer:true,maxPayload:16384});
  server.on("upgrade",(req,socket,head)=>{
    if(closingHost||paused||req.headers.host!==new URL(url).host||(req.headers.origin!==url&&!allowedOrigins.includes(req.headers.origin))||req.url!==`/${id}`||active){
      socket.end(`HTTP/1.1 ${active?"409 Conflict":"403 Forbidden"}\r\nConnection: close\r\n\r\n`);return;
    }
    ws.handleUpgrade(req,socket,head,client=>ws.emit("connection",client));
  });
  ws.on("connection",client=>{
    const session={id:randomUUID(),seq:0,recording:false,buffers:[],job:undefined,tail:Promise.resolve(),opening:undefined,opened:false,closing:undefined,history:[]};
    active=session;
    const send=(value)=>{if(client.readyState===1)client.send(JSON.stringify(value));};
    const current=(job)=>session.job===job&&!job.abort.signal.aborted&&!session.closing&&client.readyState===1;
    const cancel=()=>{session.job?.abort.abort(new Error("Voice response interrupted."));session.recording=false;session.buffers=[];};
    const close=()=>{
      if(session.closing)return session.closing;
      cancel();
      session.closing=Promise.resolve().then(async()=>{
        try{
          await session.opening?.catch(()=>{});
          await session.tail.catch(()=>{});
          await session.conversation?.close();
        }catch(error){
          send({type:"error",message:String(error.message??error).slice(0,1000)});
        }
        finally{send({type:"voice/closed"});client.close();if(active===session)active=undefined;}
      });return session.closing;
    };
    session.close=close;
    const fail=(error)=>{send({type:"error",message:String(error.message??error).slice(0,1000)});void close();};
    const retain=(row)=>{
      session.history.push(row);
      while(session.history.length>20||JSON.stringify(session.history).length>24000)session.history.shift();
    };
    function commit(){
      const seq=session.seq,frames=session.buffers;session.buffers=[];session.recording=false;
      if(frames.length<5)throw new Error("Voice utterance is too short.");
      const samples=new Float32Array(frames.length*960);frames.forEach((frame,i)=>samples.set(frame,i*960));
      const previous=session.tail,job={abort:new AbortController(),seq};session.job=job;
      session.tail=(async()=>{
        await previous.catch(()=>{});if(!current(job))return;
        const signal=job.abort.signal,responseId=`${id}:${session.id}:${seq}`;
        const emit=(value)=>{if(current(job))send({seq,...value});};
        try{
          emit({type:"response-started",responseId});emit({type:"activity",activity:"thinking"});
          const text=await backend.transcribe(samples,signal);if(!current(job))return;
          if(!text.trim()){emit({type:"response-ended"});emit({type:"activity",activity:"listening"});return;}
          if(text.length>4000)throw new Error("Transcription exceeded the limit.");
          retain({role:"user",content:text});emit({type:"transcript",speaker:"user",text});
          const answer=await (session.conversation??backend).reply([...session.history],signal);if(!current(job))return;
          if(typeof answer!=="string"||!answer.trim()||answer.length>1200)throw new Error(`Invalid ${name} spoken response.`);
          const audio=await backend.synthesize(answer,signal);if(!current(job))return;
          if(!audio.length||audio.length>48000*60||audio.some(value=>!Number.isFinite(value)||Math.abs(value)>1))throw new Error("Invalid TTS audio.");
          emit({type:"transcript",speaker:"assistant",text:answer});
          const origin=performance.now();
          for(let offset=0;offset<audio.length;offset+=960){
            signal.throwIfAborted();if(!current(job))return;
            if(client.bufferedAmount>128*1024)throw new Error(`${name} audio output is backlogged.`);
            const bytes=Buffer.alloc(3844);bytes.writeUInt32LE(seq,0);
            for(let i=0;i<960;i++)bytes.writeFloatLE(audio[offset+i]??0,4+i*4);
            client.send(bytes);
            await delay(Math.max(0,origin+(offset/960+1)*20-performance.now()),undefined,{signal});
          }
          if(!current(job))return;
          retain({role:"assistant",content:answer});emit({type:"response-ended"});emit({type:"activity",activity:"listening"});
        }catch(error){if(error.fatal||!signal.aborted&&current(job))fail(error);}
        finally{if(session.job===job)session.job=undefined;}
      })();
    }
    client.on("message",(data,binary)=>{
      try{
        if(session.closing)return;
        if(binary){
          if(!session.opened||!session.recording||data.length!==3840||session.buffers.length>=1500)throw new Error("Invalid microphone frame.");
          const samples=Float32Array.from({length:960},(_,i)=>data.readFloatLE(i*4));
          if(samples.some(value=>!Number.isFinite(value)||Math.abs(value)>1))throw new Error("Invalid microphone samples.");
          session.buffers.push(samples);return;
        }
        const message=JSON.parse(data.toString());
        if(message.type==="voice/close"){void close();return;}
        if(message.type==="voice/open"){
          if(session.opening)throw new Error(`${name} voice is already opening.`);
          session.opening=(async()=>{const status=await inspect();if(!status.ready)throw new Error(status.error??`${name} voice is not ready.`);
            if (session.closing) return;
            session.conversation = await backend.openSession?.();
            if(!session.closing){session.opened=true;send({type:"voice/ready"});}})();
          void session.opening.catch(fail);return;
        }
        if(!session.opened)throw new Error(`${name} voice is not open.`);
        if(message.type==="input/start"){
          if(!Number.isSafeInteger(message.seq)||message.seq<=session.seq||message.seq>0xffffffff)throw new Error("Invalid utterance sequence.");
          cancel();session.seq=message.seq;session.recording=true;return;
        }
        if(message.seq!==session.seq)throw new Error("The client does not own that voice turn.");
        if(message.type==="voice/interrupt"||message.type==="input/cancel"){cancel();send({type:"activity",seq:session.seq,activity:"listening"});return;}
        if(message.type==="input/commit"&&session.recording){commit();return;}
        throw new Error(`Unsupported ${name} voice operation.`);
      }catch(error){fail(error);}
    });
    client.on("close",()=>{void close();});client.on("error",()=>{void close();});
  });
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",done);});
  url=`http://127.0.0.1:${server.address().port}`;
  return{
    url,inspect,get busy(){return!!active;},
    pauseIfIdle(){
      if(active||paused||closingHost)return undefined;
      paused=true;
      return()=>{paused=false;};
    },
    async close(){closingHost=true;loginAbort.abort(new Error("Huddle host closed."));await login?.catch(()=>{});await active?.close();for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));await new Promise(done=>{server.close(done);server.closeAllConnections();});},
  };
}
