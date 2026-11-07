import {randomUUID} from 'node:crypto';
import {access,mkdir,readdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createAgentSession,z,type AgentSession,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {SessionManager} from '@oh-my-pi/pi-coding-agent/session/session-manager';
import {discoverAgents,getAgent} from '@oh-my-pi/pi-coding-agent/task/discovery';
import {cfgTaskAgentModelOverrides,cfgTaskDisabledAgents} from '@oh-my-pi/pi-coding-agent/task/settings';
import {createMCPProxyTools,followMCPTools,type MCPToolFollower} from '@oh-my-pi/pi-coding-agent/task/executor';
import {MCPManager} from '@oh-my-pi/pi-coding-agent/mcp/manager';
import {USER_TODO_EDIT_CUSTOM_TYPE} from '@oh-my-pi/pi-coding-agent/tools/todo';
import {resolveAgentModelSelection} from '@oh-my-pi/pi-coding-agent/config/model-resolver';
import {initializeExtensions} from '@oh-my-pi/pi-coding-agent/modes/runtime-init';
import {buildPublicGrammar} from '../domain/public-grammar.ts';
import {ASKING} from '../domain/workflow.ts';
import {parseToolParameters} from '../domain/parse.ts';
import type {Caller,PortInput,Repo,Result,Role} from '../domain/model.ts';
import type {HostPort,SeatExit,SeatLaunch} from './contracts.ts';
import {checkout,git,lockBare,type Worktree} from './bare-cache.ts';
import type {ControllerOutput,RuntimeError} from '../runtime/controller.ts';
import {tr} from '../i18n.ts';

const contractSchema=z.object({systemPrompt:z.array(z.string()),tools:z.array(z.string()),mountedTools:z.array(z.string())}).strict();
const handoffSchema=z.object({ticketId:z.string(),notes:z.number().int().nonnegative(),rulings:z.number().int().nonnegative()}).strict();
type LiveSeat={input:SeatLaunch;session:AgentSession|null;done:Promise<void>};
export type HostOptions={dataDir:string;ticketRevision:(ticketId:string)=>number|null;execute:(caller:Caller,input:PortInput)=>Promise<Result<ControllerOutput,RuntimeError>>;onExit:(seat:SeatExit,handedOff:boolean,error:string|null)=>void;onSeatError:(ticketId:string,message:string)=>void};

/** Owns only the sessions and worktrees it creates; the native registry owns their identities. */
export function createHostPort(options:HostOptions):HostPort {
  const registry=AgentRegistry.global();
  const seats=new Map<string,LiveSeat>();
  // Every (ticket, role, revision) this host has seated, live or ended. A seat that ends without a handoff
  // is escalated asynchronously; until then its revision must not be seated again.
  const seatedRevisions=new Set<string>();
  const reposDir=join(options.dataDir,'repos'),worktreesDir=join(options.dataDir,'worktrees'),sessionsDir=join(options.dataDir,'sessions');
  let disposed=false;
  function main():AgentSession {
    const root=registry.get(MAIN_AGENT_ID);
    if(!root?.session||root.kind!=='main'||root.status==='aborted')throw new Error('The native Main session is unavailable');
    return root.session;
  }
  /** The definition a seat agent name resolves to in this workspace, as the native task tool would resolve it. */
  async function seatAgent(parent:AgentSession,cwd:string,name:string){
    const discovery=await discoverAgents(cwd,undefined,parent.effectiveExtensionRoots);
    const agent=getAgent([...discovery.agents,...parent.getSessionAgents()],name);
    if(!agent||cfgTaskDisabledAgents.get(parent.settings).includes(name))throw new Error(`Configured seat agent is unavailable: ${name}`);
    if(agent.blocking)throw new Error(`Dispatch requires a nonblocking seat agent: ${name}`);
    return agent;
  }
  return {
    bind(ctx){
      const ref=registry.get(ctx.agent.id);
      if(!ref?.session||ref.session.sessionManager!==ctx.sessionManager)return {ok:false,error:{kind:'precondition',message:'Caller is not the current native session'}};
      if(ref.id===MAIN_AGENT_ID&&ref.kind==='main')return {ok:true,value:{kind:'main',agentId:ref.id,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile()??null}};
      const seat=seats.get(ref.id),file=ctx.sessionManager.getSessionFile();
      if(!seat||seat.session!==ref.session||!file)return {ok:false,error:{kind:'precondition',message:'Caller is not a one-shot ticket seat'}};
      return {ok:true,value:{kind:'seat',agentId:ref.id,sessionId:ctx.sessionManager.getSessionId(),sessionFile:file,ticketId:seat.input.ticketId,revision:seat.input.revision,role:seat.input.role}};
    },
    async agents(cwd,names){
      try {
        const parent=main();
        for(const name of new Set(names))await seatAgent(parent,cwd,name);
        return {ok:true,value:null};
      }catch(error){return {ok:false,error:{kind:'precondition',message:error instanceof Error?error.message:String(error)}};}
    },
    active(ticketId,role){return [...seats.values()].some(seat=>seat.input.ticketId===ticketId&&seat.input.role===role);},
    seated(ticketId,role,revision){return seatedRevisions.has(JSON.stringify([ticketId,role,revision]));},
    async launch(input){
      if(disposed)return {ok:false,error:{kind:'precondition',message:'Seat host has shut down'}};
      if([...seats.values()].some(seat=>seat.input.ticketId===input.ticketId&&seat.input.role===input.role))return {ok:false,error:{kind:'precondition',message:'Ticket role already has a live session'}};
      const id=`Rt${randomUUID().replaceAll('-','')}`;
      // This is a lifecycle reservation, not an observation of a native session.
      const seat:LiveSeat={input,session:null,done:Promise.resolve()};seats.set(id,seat);
      seatedRevisions.add(JSON.stringify([input.ticketId,input.role,input.revision]));
      let manager:SessionManager|undefined,tree:Worktree|null=null,mcpFollower:MCPToolFollower|undefined;
      const fork=input.workspace.kind==='fork'?input.workspace.sessionFile:null;
      try {
        const parent=main();
        if(!parent.asyncJobManager)throw new Error('Dispatch requires the native async job manager');
        if(parent.getPlanModeState()?.enabled)throw new Error('Dispatch seats require an executing Main');
        const agent=await seatAgent(parent,input.cwd,input.agent);
        const sessionDir=join(sessionsDir,input.agendaId);
        await mkdir(sessionDir,{recursive:true,mode:0o700});
        let workspace:string;
        if(input.workspace.kind==='fork'){
          if(input.seat!=='work')throw new Error('Judge sessions must never inherit history');
          const prior=await SessionManager.peekSessionInit(input.workspace.sessionFile);
          if(!prior)throw new Error('Owner fork source has no native session contract');
          workspace=prior.cwd;
          // The controller forks only after the predecessor seat exited and flushed. A tail cut by
          // that exit is repaired into a valid transcript, and the fork does not re-bill inherited spend.
          manager=await SessionManager.forkFrom(input.workspace.sessionFile,workspace,sessionDir,undefined,{copyArtifacts:false,suppressBreadcrumb:true,resetInheritedCost:true,repairInterruptedTail:true});
        }else{
          tree=await checkout(reposDir,join(worktreesDir,input.agendaId,id),input.cwd,input.workspace);workspace=tree.path;
          manager=SessionManager.create(workspace,sessionDir);
          await manager.ensureOnDisk();
        }
        const sessionFile=manager.getSessionFile();if(!sessionFile)throw new Error('Native seat session must be persistent');
        let inheritedContract:unknown,previousHandoff:unknown;
        for(const entry of manager.getEntries())if(entry.type==='custom'){
          if(entry.customType==='dispatch-session-contract')inheritedContract=entry.data;
          if(entry.customType==='dispatch-handoff')previousHandoff=entry.data;
        }
        const savedContract=contractSchema.safeParse(inheritedContract);
        if(fork&&!savedContract.success)throw new Error('Owner session is missing its original prompt/tool contract');
        const handoff=handoffSchema.safeParse(previousHandoff);
        if(fork&&(!handoff?.success||handoff.data.ticketId!==input.ticketId))throw new Error('Owner fork source does not contain this ticket’s accepted handoff');
        let handedOff=false,asked=false;
        const caller:Caller={kind:'seat',agentId:id,sessionId:manager.getSessionId(),sessionFile,ticketId:input.ticketId,revision:input.revision,role:input.role};
        const nativeManager=manager;
        const tool:ToolDefinition={name:'dispatch',label:tr('Dispatch','调度'),description:'Read or hand off only your bound ticket. A successful submit/verdict/escalate ends this seat.',parameters:buildPublicGrammar(z).toolParametersSchema,
            async execute(_id,params){
              if(handedOff)return {content:[{type:'text',text:'This seat has already handed off.'}],details:null,isError:true};
              const current=registry.get(id);
              if(!current?.session||current.session!==seat.session)return {content:[{type:'text',text:'Native seat identity changed.'}],details:null,isError:true};
              const parsed=parseToolParameters(params);
              if(!parsed.ok)return {content:[{type:'text',text:JSON.stringify(parsed.error)}],details:null,isError:true};
              const response=await options.execute(caller,parsed.value.input);
              if(response.ok&&['submit','verdict','escalate'].includes(parsed.value.input.op)){
                handedOff=true;
                if(input.seat==='work'&&'ticket' in response.value&&'sessions' in response.value.ticket){
                  nativeManager.appendCustomEntry('dispatch-handoff',{ticketId:input.ticketId,notes:response.value.ticket.notes.length,rulings:response.value.ticket.rulings.length});
                  // The engine parks a work seat's question in Asking only under PM integration; that seat stops here.
                  asked=response.value.ticket.state===ASKING;
                }
              }
              return {content:[{type:'text',text:JSON.stringify(response)}],details:response,isError:!response.ok};
            },
        };
        // A seat is a full native session: Main's prepared extensions and extension roots, the workspace's settings,
        // custom tools and MCP, and delegation per its agent definition. Only the bound dispatch tool is added.
        const settings=(await parent.settings.cloneForCwd(workspace)).overlay({
          // Seats run headless: the ticket launch is the authorization boundary and no UI can answer approvals.
          'tools.approvalMode':'yolo',
          // A seat's work is one long turn; post-turn compaction would only run after it ends.
          'compaction.midTurnEnabled':true,
        });
        const spawns=agent.spawns===undefined||agent.spawns==='*'?'*':agent.spawns.join(',');
        const agentTools=agent.tools&&[...new Set([...agent.tools,'task','wait','dispatch'])];
        const override=cfgTaskAgentModelOverrides.get(settings)[input.agent];
        const modelPattern=parent.model?`${parent.model.provider}/${parent.model.id}`:undefined;
        const modelSelection=resolveAgentModelSelection({settings,
          ...(override!==undefined?{settingsOverride:override}:{}),
          ...(agent.model!==undefined?{agentModel:agent.model}:{}),
          ...(modelPattern!==undefined?{activeModelPattern:modelPattern,fallbackModelPattern:modelPattern}:{}),
        });
        const cacheKey=manager.getHeader()?.providerPromptCacheKey??manager.getHeader()?.id;
        // Main's MCP manager is shared like a native subagent's; its tools follow reloads through proxies.
        const mcpManager=MCPManager.instance();
        mcpFollower=mcpManager?followMCPTools(mcpManager,new Set(['dispatch'])):undefined;
        const mcpTools=mcpManager?createMCPProxyTools(mcpManager).filter(proxy=>proxy.name!=='dispatch'):[];
        const created=await createAgentSession({cwd:workspace,sessionManager:manager,authStorage:parent.modelRegistry.authStorage,modelRegistry:parent.modelRegistry,
          credentialSourceSessionId:parent.sessionManager.getSessionId(),settings,
          ...(!fork&&modelSelection.patterns?{modelPattern:modelSelection.patterns}:{}),
          ...(fork&&cacheKey?{providerPromptCacheKey:cacheKey,providerPromptCacheKeySource:'fork' as const}:{}),
          ...(savedContract.success
            ?{systemPrompt:savedContract.data.systemPrompt,toolNames:savedContract.data.tools,mountedToolNames:savedContract.data.mountedTools}
            :{appendSystemPrompt:agent.systemPrompt,...(agentTools?{toolNames:agentTools}:{})}),
          // The SDK registers custom tools after extension tools, so this bound tool replaces the inactive
          // dispatch tool the extension itself registers inside the seat.
          customTools:[tool],enableMCP:true,
          ...(mcpManager?{mcpManager,...(mcpTools.length?{mcpTools}:{})}:{}),
          // An empty list would bind no extensions and prune Main's extension-provided model sources.
          ...(parent.preparedExtensions?.length?{preloadedPreparedExtensions:parent.preparedExtensions}:{}),
          ...(parent.extensionPaths?.length?{preloadedExtensionPaths:[...parent.extensionPaths]}:{}),
          extensionRoots:()=>parent.effectiveExtensionRoots,
          // A seat reports to Main only through its ticket, never as an IRC peer.
          hasUI:false,bindProcessState:false,cacheWarming:false,enableIrc:false,
          agentId:id,agentName:agent.name,agentDisplayName:`${input.role}: ${input.ticketId}`,parentAgentId:MAIN_AGENT_ID,parentTaskPrefix:id,taskDepth:1,expectedAgentRef:null,
          spawns,inheritedSessionAgents:parent.getSessionAgents(),
        });
        seat.session=created.session;
        mcpFollower?.bind(created.session);
        const extensionSends:Promise<unknown>[]=[];
        await initializeExtensions(created.session,{reportSendError:(_action,error)=>options.onSeatError(input.ticketId,error.message),reportRuntimeError:error=>options.onSeatError(input.ticketId,error.error),
          trackExtensionSend:send=>{extensionSends.push(send.catch(()=>{}));}});
        while(extensionSends.length)await Promise.all(extensionSends.splice(0));
        // Extensions settle the active set on session_start (omp-unified-exec replaces bash with exec_command).
        const tools=created.session.getEnabledToolNames();
        if(!tools.includes('dispatch'))throw new Error('Seat session did not enable its dispatch tool');
        if(fork){
          // Like a native fork, the rework seat must not inherit its predecessor's finished todo list.
          created.session.setTodoPhases([]);
          manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE,{phases:[]});
        }else{
          // The base prompt (before any per-turn extension rewrite) and tool presentation a rework fork restores for an identical prefix.
          manager.appendCustomEntry('dispatch-session-contract',{systemPrompt:created.session.systemPrompt,tools,mountedTools:created.session.getMountedXdevToolNames()});
          manager.appendSessionInit({systemPrompt:created.session.systemPrompt,task:input.prompt,tools,agent:agent.name,readOnly:input.seat!=='work',spawns});
        }
        const opening=fork&&handoff?.success
          ? `Continue ticket ${input.ticketId} at revision ${input.revision}. Only the incremental handoff follows. Call dispatch read if the current contract or PR is needed.\n${JSON.stringify({notes:input.ticket.notes.slice(handoff.data.notes),rulings:input.ticket.rulings.slice(handoff.data.rulings)})}`
          : input.prompt;
        // A seat resumed after its question was answered reads the answer first.
        const prompt=input.resume===null?opening:`${input.resume}\n\n${opening}`;
        // A work seat's checkout outlives the seat for rework forks until finish; a judge checkout ends with its seat.
        const session=created.session,disposable=input.seat==='work'?null:tree;
        // Like native terminal-yield handling, abort the obsolete tool loop at a
        // tool-completion boundary. Accepted handoffs have already saved their
        // checkpoint and must finish normally, even if their transition bumped revision;
        // a question handed to the intent guardians ends its seat right there.
        const unsubscribe=session.subscribe(event=>{
          if(event.type!=='tool_execution_end')return;
          if(asked){session.agent.abort('Dispatch handed this question to the intent guardians');return;}
          if(handedOff)return;
          const revision=options.ticketRevision(input.ticketId);
          if(revision!==null&&revision!==input.revision)session.agent.abort('Dispatch seat revision was superseded');
        });
        const completion=Promise.withResolvers<void>();
        seat.done=completion.promise;
        const jobId=parent.asyncJobManager.register('task',`${input.role}: ${input.ticketId}`,async({signal})=>{
          const abort=()=>{void session.abort();};
          signal.addEventListener('abort',abort,{once:true});
          let error:string|null=null;
          try {
            if(signal.aborted)throw new Error('Seat was cancelled before dispatch');
            await session.prompt(prompt);
            await session.waitForIdle();
            while(session.hasPendingAsyncWork()){
              if(signal.aborted)throw new Error('Seat was cancelled while descendant work settled');
              await session.settleAsyncWork();
            }
            if(!handedOff){
              // A model request that finally fails is recorded on the last assistant message; prompt() returns normally.
              const last=session.messages.filter(message=>message.role==='assistant').at(-1);
              if(last?.role==='assistant'&&last.stopReason==='error')error=`the model request failed: ${last.errorMessage||'unknown error'}`;
            }
            return handedOff?`Ticket ${input.ticketId} handed off.`:`Ticket ${input.ticketId} exited without handoff.`;
          }catch(cause){
            error=cause instanceof Error?cause.message:String(cause);
            throw cause;
          }finally {
            signal.removeEventListener('abort',abort);
            unsubscribe();
            try {await session.dispose();}catch(cause){error??=cause instanceof Error?cause.message:String(cause);}
            seats.delete(id);
            try {
              if(disposable)await lockBare(disposable.bare,()=>git(['-C',disposable.bare,'worktree','remove','--force',disposable.path]));
            }catch(cause){error??=cause instanceof Error?cause.message:String(cause);}
            finally {options.onExit({ticketId:input.ticketId,role:input.role,revision:input.revision},handedOff,error);completion.resolve();}
          }
        },{ownerId:MAIN_AGENT_ID,agentId:id});
        // A seat's outcome reaches Main through the ticket (an escalation, or the next launchable ticket), never as a
        // job completion: Main does not wait on seats. The job stays listed and inspectable.
        parent.asyncJobManager.acknowledgeDeliveries([jobId]);
        return {ok:true,value:{agentId:id,sessionId:caller.sessionId,sessionFile,jobId}};
      }catch(error){
        seats.delete(id);
        if(seat.session)await seat.session.dispose();else {mcpFollower?.dispose();if(manager)await manager.close();}
        let detail=error instanceof Error?error.message:String(error);
        if(tree){const created=tree;try {await lockBare(created.bare,()=>git(['-C',created.bare,'worktree','remove','--force',created.path]));}catch(cause){detail+=`; worktree cleanup failed: ${cause instanceof Error?cause.message:String(cause)}`;}}
        return {ok:false,error:{kind:'unavailable',message:detail}};
      }
    },
    async finish(agendaId){
      try {
        const root=join(worktreesDir,agendaId);
        if(dirname(resolve(root))!==resolve(worktreesDir))throw new Error('Invalid agenda worktree directory');
        if(!await access(root).then(()=>true,()=>false))return {ok:true,value:null};
        // Every Owner checkout of this agenda lives under its root; pruning drops their admin entries from each cache.
        await rm(root,{recursive:true,force:true});
        for(const name of await readdir(reposDir))if(name.endsWith('.git')){
          const bare=join(reposDir,name);
          await lockBare(bare,()=>git(['-C',bare,'worktree','prune']));
        }
        return {ok:true,value:null};
      }catch(error){return {ok:false,error:{kind:'unavailable',message:error instanceof Error?error.message:String(error)}};}
    },
    async dispose(){
      disposed=true;
      const live=[...seats.values()];
      for(const seat of live)if(seat.session)await seat.session.abort();
      await Promise.all(live.map(seat=>seat.done));
      seats.clear();
    },
  };
}
