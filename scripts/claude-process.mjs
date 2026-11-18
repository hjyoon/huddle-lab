import { spawn } from "node:child_process";

/** A child keeps its slot until exit, including abort. Kill only its own group. */
export async function runOwned(binary, args, { cwd, signal, input = "", timeoutMs = 60000, onLine, maxBytes = 1024 * 1024, env, captureFailureOutput = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, shell:false, detached:process.platform !== "win32", stdio:["pipe","pipe","pipe"] });
    let output = "", line = "", stderr = "", failure, killTimer;
    const kill = (kind) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid,kind); else child.kill(kind); } catch {} };
    const stop = (error) => {
      if (failure) return;
      failure=error;kill("SIGTERM");killTimer=setTimeout(()=>kill("SIGKILL"),1500);
    };
    const abort = () => stop(signal.reason ?? new Error("Operation cancelled."));
    const timeout = setTimeout(()=>stop(Object.assign(new Error(`${binary} timed out.`),{code:"ETIMEDOUT"})),timeoutMs);
    const clean = () => { clearTimeout(timeout);clearTimeout(killTimer);signal?.removeEventListener("abort",abort); };
    child.once("error",(error)=>{clean();reject(Object.assign(new Error(`Could not start ${binary}: ${error.code ?? "process error"}`),{code:error.code}));});
    child.once("close",(code)=>{
      clean();
      if (failure) reject(failure);
      else if (code !== 0) {
        const error = new Error(`${binary} exited (${code}).`);
        if(captureFailureOutput){error.stdout=output;error.stderr=stderr;}
        reject(error);
      }
      else { try { if(line.trim())onLine?.(line);resolve(output); } catch(error){reject(error);} }
    });
    if(captureFailureOutput){
      child.stderr.setEncoding("utf8");
      child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-16384);});
    }else child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",(chunk)=>{
      output+=chunk;line+=chunk;
      if(Buffer.byteLength(output)>maxBytes){stop(new Error(`${binary} output exceeded the limit.`));return;}
      let newline;
      try { while((newline=line.indexOf("\n"))>=0){const value=line.slice(0,newline);line=line.slice(newline+1);if(value.trim())onLine?.(value);} }
      catch(error){stop(error);}
    });
    child.stdin.on("error",()=>{if(!failure)stop(new Error(`${binary} input connection closed.`));});
    signal?.addEventListener("abort",abort,{once:true});
    child.stdin.end(input);
    if(signal?.aborted)abort();
  });
}
