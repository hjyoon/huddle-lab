import { request } from "node:http";
import { createServer } from "node:https";
import { isIPv4 } from "node:net";

export async function createWireGuardHttps({address,port,key,cert,handle,lookupVoice,origin}) {
  if (!isIPv4(address) || address === "0.0.0.0") throw new Error("Set one WireGuard IPv4 address.");
  const voiceSockets = new Set();
  let url;
  const server = createServer({key,cert}, (req,res) => handle(req,res,url,true));
  server.on("upgrade", (req,socket,head) => {
    const reject = (status = "403 Forbidden") => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (req.headers.host !== new URL(url).host || req.headers.origin !== url || req.headers.upgrade?.toLowerCase() !== "websocket") {
      reject();return;
    }
    const target = lookupVoice(req.url);
    if (!target) { reject("404 Not Found");return; }
    const upgrade = request(target, {headers:{
      Origin:origin,Connection:"Upgrade",Upgrade:"websocket",
      "Sec-WebSocket-Key":req.headers["sec-websocket-key"]??"",
      "Sec-WebSocket-Version":req.headers["sec-websocket-version"]??"",
    }});
    voiceSockets.add(socket);
    socket.once("close",()=>{voiceSockets.delete(socket);upgrade.destroy();});
    socket.on("error",()=>socket.destroy());
    upgrade.setTimeout(5000,()=>upgrade.destroy());
    upgrade.on("error",()=>{if(!socket.destroyed)reject("502 Bad Gateway");});
    upgrade.on("response",res=>{res.resume();reject(res.statusCode===409?"409 Conflict":"502 Bad Gateway");});
    upgrade.on("upgrade",(res,upstream,buffer)=>{
      if(socket.destroyed){upstream.destroy();return;}
      upstream.setTimeout(0);
      upstream.on("error",()=>socket.destroy());
      upstream.once("close",()=>socket.destroy());
      socket.once("close",()=>upstream.destroy());
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${res.headers["sec-websocket-accept"]}\r\n\r\n`);
      if (head.length) upstream.write(head);
      if (buffer.length) socket.write(buffer);
      upstream.pipe(socket);socket.pipe(upstream);
    });
    upgrade.end();
  });
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(port,address,done);});
  url=`https://${address}:${server.address().port}`;
  return {url,close(){
    return new Promise(done=>{
      server.close(done);
      server.closeAllConnections();
      for(const socket of voiceSockets)socket.destroy();
    });
  }};
}
