import {hostname} from 'node:os';
import {logger,z,type ExtensionAPI,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {applyActiveTools} from './active-tools.ts';
import {launcherCommand} from './src/launcher/commands.ts';
import {buildPublicGrammar} from './src/domain/public-grammar.ts';
import {parseToolParameters} from './src/domain/parse.ts';
import {Attention} from './src/runtime/attention.ts';
import {createAgendaFiles} from './src/ports/state.ts';
import {createGitHubPort} from './src/ports/github.ts';
import {createHostPort} from './src/ports/host.ts';
import {createGuardiansPort} from './src/ports/guardians.ts';
import {createProcessPort} from './src/ports/process.ts';
import {configuredWorkflow} from './src/ports/workflow-settings.ts';
import {readRuntimeSettings} from './src/ports/runtime-settings.ts';
import {tr} from './src/i18n.ts';
import {loadPmConfig,type PmConfig} from './src/pm/config.ts';
import {runtimeErrorText} from './src/runtime/error-text.ts';
import type {HostPort} from './src/ports/contracts.ts';
import {coordinatorBriefing,parseCoordinatorFlag,type CoordinatorIdentity} from './src/runtime/coordinator.ts';
import {DispatchController,type RuntimeError} from './src/runtime/controller.ts';
import {RuntimeExit} from './src/runtime/exit.ts';

const SLOT=Symbol.for('omp-dispatch.runtime.v4');
type Identity={kind:'absent'}|{kind:'invalid';message:string}|({kind:'coordinator'}&CoordinatorIdentity);

/** Main is one native session for the whole process; seats own their own SDK lifetimes. */
class ProcessRuntime {
  private identity:Identity|null=null;
  private binding:{pi:ExtensionAPI;ctx:ExtensionContext}|null=null;
  private controller:DispatchController|null=null;
  private host:HostPort|null=null;
  private readonly attention=new Attention();
  /** The host's graceful exit, granted only to a coordinator identity and spent once at an honest finish. */
  private readonly exit=new RuntimeExit();
  private started=false;
  private deferred=false;
  readIdentity(pi:ExtensionAPI):Identity {
    if(this.identity)return this.identity;
    const flag=pi.getFlag('dispatch');
    if(flag===undefined)return this.identity={kind:'absent'};
    const parsed=parseCoordinatorFlag(flag);
    return this.identity=parsed.ok?{kind:'coordinator',...parsed.value}:{kind:'invalid',message:parsed.error};
  }
  private report(error:RuntimeError):void {
    logger.error('Dispatch runtime error',{error:JSON.stringify(error)});
    this.binding?.ctx.ui.notify(runtimeErrorText(error),'error');
  }
  /**
   * Main wakes only for a decision still open when its turn ends: a launchable ticket, an Escalated ticket or
   * closure, a failed PM effect, or a finished agenda. While Main is busy it sees the agenda through its own calls, so a decision it
   * settles within the same turn (launching what convene unlocked, resolving an escalation) never wakes it again.
   */
  private changed(turnEnded=false):void {
    const agenda=this.controller?.snapshot(),binding=this.binding,host=this.host;
    if(!agenda||!binding||!host)return;
    if(!turnEnded&&!binding.ctx.isIdle()){this.deferred=true;return;}
    this.deferred=false;
    const fresh=this.attention.observe(agenda,(ticketId,role)=>host.active(ticketId,role));
    // A completed agenda has no decisions; the process may end with it. The tool's accepted `finish` and every
    // relay path that confirms completion surface here through the controller's own snapshot, so the exit fires
    // at this one gate and `session_shutdown` later keeps its `shutdown()` closing order. Unfinished states
    // (Asking, Escalated, open decisions) pass the gate unspent and the coordinator keeps running.
    this.exit.commit(agenda.lifecycle==='completed',agenda);
    if(!fresh.length)return;
    binding.pi.sendMessage({customType:'dispatch-attention',display:true,content:`Dispatch needs Main: ${fresh.join(', ')}. launch:<ticket> may be launched; escalated:<ticket>:<revision> awaits read and resolve; failed:<ticket>:<effect> is a failed PM effect (a record write, or the request asking the intent guardians to settle a worker question) that blocks finish until resolve settles it with retry, adopt or cancel, and a failed guardians request is sent again by resolve to Asking with retry on it; finish means every ticket and the closure are Done. Call dispatch status for the source-confirmed agenda; this notification is not a ticket snapshot.`},{triggerTurn:true,deliverAs:'nextTurn'});
  }
  mainTurnEnded(ctx:ExtensionContext):void {
    if(this.deferred&&this.binding?.ctx.sessionManager===ctx.sessionManager)this.changed(true);
  }
  async start(pi:ExtensionAPI,ctx:ExtensionContext,identity:CoordinatorIdentity):Promise<void> {
    if(this.started)return;
    const root=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
    if(ctx.agent.id!==MAIN_AGENT_ID||ctx.agent.kind!=='main'||!root||root.sessionManager!==ctx.sessionManager)throw new Error('Dispatch requires the actual native Main');
    this.started=true;this.binding={pi,ctx};
    // Only a coordinator identity reaches start, so the exit request binds to the exact context it was granted for.
    this.exit.grant(()=>ctx.shutdown());
    const settings=await readRuntimeSettings(ctx.cwd);
    if(!settings.ok){
      const message=`${tr('Dispatch settings are invalid; the coordinator does not start','调度设置无效，协调者不启动')}:\n${settings.error}`;
      ctx.ui.notify(message,'error');throw new Error(message);
    }
    const directory=settings.value.dataDir;
    let pm:PmConfig|null=null;
    if(settings.value.pm){
      const loaded=await loadPmConfig(settings.value.pm);
      if(!loaded.ok){
        const message=`${tr('Dispatch PM configuration is invalid; the coordinator does not start','调度 PM 配置无效，协调者不启动')}:\n${loaded.error}`;
        ctx.ui.notify(message,'error');throw new Error(message);
      }
      pm=loaded.value;
    }
    this.host=createHostPort({dataDir:directory,
      ticketRevision:ticketId=>this.controller?.ticketRevision(ticketId)??null,
      execute:async(caller,input)=>{
        if(!this.controller)return {ok:false,error:{kind:'domain',error:{kind:'ownershipBlocked',message:'Coordinator has not started'}}};
        return this.controller.execute(caller,input);
      },
      onExit:(seat,handedOff,error)=>{
        if(handedOff&&error)this.report({kind:'host',error:{kind:'unavailable',message:`Ticket ${seat.ticketId} ${seat.role} seat cleanup: ${error}`}});
        this.controller?.seatExited(seat,handedOff,error);
        this.changed();
      },
      onSeatError:(ticketId,message)=>this.report({kind:'host',error:{kind:'unavailable',message:`Ticket ${ticketId} seat: ${message}`}}),
    });
    this.controller=new DispatchController({issue:identity.issue,files:createAgendaFiles(directory),
      github:createGitHubPort({pm:pm?{owner:pm.repos.pm.project.owner,number:pm.repos.pm.project.number,statusField:pm.project.fields.status.name}:null}),host:this.host,process:createProcessPort(),cwd:ctx.cwd,
      pm:pm?{context:{host:hostname(),pid:process.pid,status:{inProgress:pm.project.fields.status.options.inProgress,done:pm.project.fields.status.options.done},
        ask:{defaultTier:pm.delivery.defaultTier,tierHelp:pm.delivery.tierHelp,resumePrompt:pm.delivery.resumePrompt}},guardians:createGuardiansPort(pm.delivery.guardiansURL)}:null,
      // Read at each convene: a configured file must exist; otherwise the data directory may override the built-in workflow.
      workflow:()=>configuredWorkflow(ctx.cwd,directory),
      intervalSeconds:settings.value.intervalSeconds,onChange:()=>this.changed(),onError:error=>this.report(error)});
    const caller=this.host.bind(ctx);if(!caller.ok||caller.value.kind!=='main')throw new Error('Cannot bind Main to the coordinator');
    this.controller.setMain(caller.value);
    await applyActiveTools(pi,[...pi.getActiveTools(),'dispatch']);
    const saved=await this.controller.startup(caller.value);
    if(!saved.ok)this.report(saved.error);
    pi.sendMessage({customType:'dispatch-start',display:true,content:coordinatorBriefing({reference:identity.reference,saved:saved.ok?{kind:'listed',active:saved.value}:{kind:'unreadable',error:JSON.stringify(saved.error)}})},{triggerTurn:true,deliverAs:'nextTurn'});
  }
  async execute(ctx:ExtensionContext,params:unknown) {
    const parsed=parseToolParameters(params);
    if(!parsed.ok)return {ok:false,error:{kind:'parse',error:parsed.error}};
    if(!this.host||!this.controller)return {ok:false,error:{kind:'inactive',message:'This process is not a Dispatch coordinator'}};
    const caller=this.host.bind(ctx);
    if(!caller.ok)return {ok:false,error:{kind:'host',error:caller.error}};
    const result=await this.controller.execute(caller.value,parsed.value.input);
    this.changed();return result;
  }
  async shutdown(ctx:ExtensionContext):Promise<void> {
    if(this.binding?.ctx.sessionManager===ctx.sessionManager)await this.controller?.shutdown();
  }
}
const slots=globalThis as typeof globalThis&{[SLOT]?:ProcessRuntime};

export default function dispatch(pi:ExtensionAPI):void {
  const runtime=slots[SLOT]??(slots[SLOT]=new ProcessRuntime());
  pi.registerFlag('dispatch',{description:tr('Start Main as coordinator for <owner>/<repo>#<number>','将 Main 启动为 <owner>/<repo>#<number> 的协调者'),type:'string'});
  pi.registerTool({name:'dispatch',label:tr('Dispatch','调度'),description:'Main coordinates a durable ticket graph and launches each ticket once; Dispatch then relays its seats until Done, Escalated, or Asking (a work seat\'s question with the intent guardians, which resumes the worker on a reply or ends the ticket Replaced). Seats read one ticket and hand off with submit/verdict/escalate. GitHub writes are performed and freshly confirmed by the state machine.',parameters:buildPublicGrammar(z).toolParametersSchema,defaultInactive:true,
    async execute(_id,params,_signal,_update,ctx){const response=await runtime.execute(ctx,params);return {content:[{type:'text',text:JSON.stringify(response)}],details:response,isError:!response.ok};},
  });
  pi.registerCommand('dispatch-launcher',{description:tr('Install, uninstall, or inspect the local Dispatch launcher, or register its GitHub App (install|uninstall|status|github-app register --webhook-url <url>)','安装、卸载或查看本地调度启动器，或注册其 GitHub App（install|uninstall|status|github-app register --webhook-url <url>）'),async handler(args,ctx){const result=await launcherCommand(args.trim().split(/\s+/).filter(part=>part.length>0));ctx.ui.notify(result.ok?result.value:result.error,result.ok?'info':'error');}});
  pi.on('session_start',async(_event,ctx)=>{
    const identity=runtime.readIdentity(pi);
    if(identity.kind==='absent')return;
    if(identity.kind==='invalid'){ctx.ui.notify(tr('--dispatch must carry a value of the form <owner>/<repo>#<number>','--dispatch 的值必须为 <owner>/<repo>#<number> 格式'),'error');return;}
    if(ctx.agent.id===MAIN_AGENT_ID&&ctx.agent.kind==='main')await runtime.start(pi,ctx,identity);
  });
  pi.on('agent_end',(_event,ctx)=>runtime.mainTurnEnded(ctx));
  pi.on('session_shutdown',async(_event,ctx)=>runtime.shutdown(ctx));
}
