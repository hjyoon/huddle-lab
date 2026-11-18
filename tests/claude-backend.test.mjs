import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalClaudeBackend } from "../scripts/claude-backend.mjs";

/** Mirrors Claude Code: `auth status` prints JSON and exits 1 when signed out. */
function fakeClaude({signedIn=false,loginSignsIn=true}={}){
  const calls=[];
  const run=async(binary,args,options={})=>{
    calls.push(args.join(" "));
    if(args[0]==="--version")return"2.0.0 (Claude Code)\n";
    if(args.join(" ")==="auth status"){
      const output=JSON.stringify({loggedIn:signedIn});
      if(signedIn)return output;
      throw Object.assign(new Error(`${binary} exited (1).`),options.captureFailureOutput?{stdout:output,stderr:""}:{});
    }
    if(args.join(" ")==="auth login"){if(loginSignsIn)signedIn=true;else throw new Error(`${binary} exited (1).`);return"";}
    throw new Error("Speech is not installed in this fixture.");
  };
  return{calls,run};
}

test("signed-out Claude reports a login requirement instead of a bare exit code",async()=>{
  const backend=createLocalClaudeBackend({run:fakeClaude().run});
  const status=await backend.inspect();
  assert.equal(status.ready,false);assert.equal(status.needsLogin,true);assert.equal(status.signedIn,false);
  assert.doesNotMatch(status.error,/exited/);
});

test("login runs claude auth login only while signed out and confirms the result",async()=>{
  const out=fakeClaude();await createLocalClaudeBackend({run:out.run}).login();
  assert.deepEqual(out.calls,["auth status","auth login","auth status"]);
  const already=fakeClaude({signedIn:true});await createLocalClaudeBackend({run:already.run}).login();
  assert.deepEqual(already.calls,["auth status"]);
  await assert.rejects(createLocalClaudeBackend({run:fakeClaude({loginSignsIn:false}).run}).login(),/claude auth login/);
});
