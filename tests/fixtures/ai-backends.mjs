// Protocol fixtures only: no AI inference.
export function providerFixtures() {
  const calls={codexStarts:0,codexClosed:0,claudeInspections:0,openclawInspections:0,openclawReplies:0,hermesReplies:0};
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
    openclaw:{backend:{async inspect(){calls.openclawInspections++;return{ready:true,version:'OpenClaw test provider',workspace:process.cwd(),modelName:'test/model'};},
      async transcribe(){return'openclaw test';},async reply(){calls.openclawReplies++;return'OpenClaw fixture response';},async synthesize(){return new Float32Array(960*5).fill(.1);},
    }},
    hermes:{backend:{async inspect(){return{ready:true,version:'Hermes test provider',workspace:process.cwd(),modelName:'hermes-agent'};},
      async transcribe(){return'hermes test';},async reply(){calls.hermesReplies++;return'Hermes fixture response';},async synthesize(){return new Float32Array(960*5).fill(.1);},
    }},
    claude:{backend:{async inspect(){calls.claudeInspections++;return{ready:true,version:'Claude test provider',workspace:process.cwd()};},
      async transcribe(){return'test';},async reply(){return'fixture response';},async synthesize(){return new Float32Array(960*5).fill(.1);},
    }},
  };
}
