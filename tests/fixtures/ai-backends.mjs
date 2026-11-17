// Protocol fixtures only: no Codex or Claude inference.
export function providerFixtures() {
  const calls={codexStarts:0,codexClosed:0,claudeInspections:0};
  return {calls,
    codex:{async createRpc(){return{
      subscribe(){return()=>{};},async close(){calls.codexClosed++;},
      async request(method){
        if(method==='account/read')return{account:{type:'fixture'}};
        if(method==='thread/start')return{thread:{id:'codex-test-thread'}};
        if(method==='thread/realtime/start'){calls.codexStarts++;throw new Error('Codex fixture selected (no inference)');}
        return{};
      },
    };}},
    claude:{backend:{async inspect(){calls.claudeInspections++;return{ready:true,version:'Claude test provider',workspace:process.cwd()};},
      async transcribe(){return'test';},async reply(){return'fixture response';},async synthesize(){return new Float32Array(960*5).fill(.1);},
    }},
  };
}
