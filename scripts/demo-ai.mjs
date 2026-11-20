import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAiHost } from "./ai-host.mjs";
import { createOpenClawRemoteStore } from "./openclaw-remote-store.mjs";
const runtime=resolve(process.env.HUDDLE_RUNTIME_DIR??fileURLToPath(new URL("../.huddle-runtime",import.meta.url)));
const vpnDirectory=resolve(runtime,"wireguard");
const run=promisify(execFile);
const speech={
 runtimeRoot:resolve(runtime,"claude"),
 python:process.env.HUDDLE_CLAUDE_PYTHON||undefined,
 model:process.env.HUDDLE_CLAUDE_ASR_MODEL??"base",
 language:process.env.HUDDLE_CLAUDE_LANGUAGE??"ko",
 voice:process.env.HUDDLE_CLAUDE_VOICE,
};
async function hasWireGuardAddress(address){
 const names=Object.entries(networkInterfaces())
  .filter(([,addresses])=>addresses.some(item=>item.family==="IPv4"&&item.address===address))
  .map(([name])=>name);
 if(names.some(name=>/^(?:utun|wg)\d+$/.test(name)))return true;
 if(process.platform!=="linux"||!names.length)return false;
 try{
  const {stdout}=await run("ip",["-json","-details","link","show","type","wireguard"]);
  return JSON.parse(stdout).some(link=>names.includes(link.ifname)&&link.linkinfo?.info_kind==="wireguard");
 }catch{return false;}
}
async function readWireGuardOptions(){
 const address=process.env.HUDDLE_WIREGUARD_IP??await readFile(resolve(vpnDirectory,"address"),"utf8").then(value=>value.trim(),error=>{
  if(error.code!=="ENOENT")throw error;
 });
 if(!address)return;
 if(!await hasWireGuardAddress(address)){console.warn(`WireGuard tunnel address ${address} is unavailable. Serving Huddle locally.`);return;}
 const [key,cert]=await Promise.all([
  readFile(process.env.HUDDLE_WIREGUARD_TLS_KEY??resolve(vpnDirectory,"server-key.pem")),
  readFile(process.env.HUDDLE_WIREGUARD_TLS_CERT??resolve(vpnDirectory,"server-cert.pem")),
 ]);
 return {address,key,cert};
}
const host=await createAiHost({port:Number(process.env.PORT??4184),cwd:resolve(process.env.HUDDLE_WORKSPACE??process.cwd()),
 remoteStore:createOpenClawRemoteStore(runtime),wireguard:await readWireGuardOptions(),
 codex:{binary:process.env.HUDDLE_CODEX_BINARY??"codex",model:process.env.HUDDLE_CODEX_MODEL||undefined,
  runtimeRoot:resolve(runtime,"codex"),
  openclawMain:process.env.HUDDLE_CODEX_OPENCLAW_MAIN==="1",voiceModel:process.env.HUDDLE_CODEX_VOICE_MODEL||undefined,
  requireChatGpt:!!process.env.HUDDLE_CODEX_VOICE_MODEL},
 claude:{...speech,binary:process.env.HUDDLE_CLAUDE_BINARY??"claude"},
 openclaw:{...speech,binary:process.env.HUDDLE_OPENCLAW_BINARY??"openclaw",agent:process.env.HUDDLE_OPENCLAW_AGENT,modelRef:process.env.HUDDLE_OPENCLAW_MODEL},
 hermes:{...speech,settings:{url:process.env.HUDDLE_HERMES_URL,apiKey:process.env.HUDDLE_HERMES_KEY}},
});
console.log(`AI Huddle (choose Codex, Claude, OpenClaw or Hermes): ${host.url}/`);
if(host.vpnUrl)console.log(`AI Huddle over WireGuard: ${host.vpnUrl}/`);
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{void host.close().then(()=>process.exit(0));});
