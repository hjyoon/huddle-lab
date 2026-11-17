import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodexRpc } from "../scripts/codex-rpc.mjs";

test("Codex JSONL initializes, multiplexes requests, rejects server tools and closes owned runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(),"huddle-rpc-test-"));t.after(()=>rm(root,{recursive:true,force:true}));
  let child, seen=[], buffer="", argv;
  const spawnProcess = (_, args) => {
    argv=args; child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){child.emit("exit",0);}});
    child.stdin.on("finish",()=>queueMicrotask(()=>child.emit("exit",0)));
    child.stdin.on("data",(data)=>{
      buffer+=data;let end;
      while((end=buffer.indexOf("\n"))>=0){
        const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);seen.push(message);
        if(message.method && message.id) queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result:message.method==="initialize"?{userAgent:"fixture"}:{ok:true}})+"\n"));
      }
    }); return child;
  };
  const rpc = await openCodexRpc({cwd:process.cwd(),runtimeRoot:root,spawnProcess});
  assert.equal(rpc.initialized.userAgent,"fixture");assert.ok(argv.includes("--stdio"));
  assert.deepEqual(await rpc.request("account/read"),{ok:true});
  child.stdout.write('{"id":99,"method":"item/tool/call","params":{}}\n');
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(seen.find(x=>x.id===99).error.code,-32601);
  await Promise.all([rpc.close(),rpc.close()]);assert.deepEqual(await readdir(root),[]);
  await assert.rejects(rpc.request("account/read"),/closed/);
});
