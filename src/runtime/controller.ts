import {randomUUID} from 'node:crypto';
import type {Agenda,Caller,DomainError,Effect,EffectResult,Facts,PmContext,PortError,PortInput,Result,Role,Workflow} from '../domain/model.ts';
import {REPLAYABLE,abandonSeat,applyOperation,availableRoles,awaitsLaunch,closureRoles,confirmEffect,createAgenda,currentSeat,effectPrecondition,failEffect,reconcile,satisfiedResult,statusOnDone,ticketDefinition,workerStarted} from '../domain/engine.ts';
import {canonical,sameRef} from '../domain/identity.ts';
import {seatBrief} from '../domain/briefs.ts';
import {parentSeatRoles,ticketSeatRoles,workflowAgents} from '../domain/workflow.ts';
import type {AgendaFiles,GitHubPort,GuardiansPort,HostPort,ProcessPort,SeatExit,SeatHandle,SeatLaunch,SeatWorkspace,StateError,WorkflowError} from '../ports/contracts.ts';
import {createSourceReader,type SourceReceipt} from './source.ts';

export type RuntimeError={kind:'domain';error:DomainError}|{kind:'storage';error:StateError}|{kind:'source'|'host'|'process';error:PortError}|{kind:'workflow';error:WorkflowError};
/** Main's view: which tickets it may launch, which wait on a worker's question to the intent guardians, and which seats the relay currently runs. */
export type AgendaView={agenda:Agenda;launchable:string[];asking:{ticketId:string;question:string;comment:number|null}[];seated:{ticketId:string;roles:Role[]}[]};
export type ControllerOutput=AgendaView|{active:string[]}|{ticket:Agenda['tickets'][number]|NonNullable<Agenda['closure']>}|{launched:SeatHandle[]};
/**
 * `workflow` reads the workflow a new agenda will freeze; an attached agenda never consults it.
 * `pm` turns on PM integration: work seats record their sessions on their issues, Project Status follows delivery,
 * and a work seat's question goes to the intent guardians behind `guardians`.
 */
export type ControllerOptions={files:AgendaFiles;github:GitHubPort;host:HostPort;process:ProcessPort;cwd:string;workflow:()=>Promise<Result<Workflow,WorkflowError>>;intervalSeconds:number;pm:{context:PmContext;guardians:GuardiansPort}|null;onChange:()=>void;onError:(error:RuntimeError)=>void};
function domain(kind:DomainError['kind'],message:string):{ok:false;error:RuntimeError}{return {ok:false,error:{kind:'domain',error:{kind,message}}};}

/** The controller is the sole writer of its agenda. GitHub observations are never optimistic writes. */
export class DispatchController {
  readonly runId=randomUUID();
  private readonly source;
  private state:Agenda|null=null;
  private main:Extract<Caller,{kind:'main'}>|null=null;
  private tail:Promise<void>=Promise.resolve();
  private pending:{expected:number|null;state:Agenda}|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;
  private scheduled:ReturnType<typeof setTimeout>|null=null;
  private closed=false;
  constructor(private readonly options:ControllerOptions){this.source=createSourceReader(options.github);}
  setMain(caller:Extract<Caller,{kind:'main'}>):void {
    if(this.main&&this.main.sessionId!==caller.sessionId)throw new Error('The coordinator session cannot change within a run');
    this.main=caller;
  }
  /** The agenda owns ticket revisions; the host uses this only to end superseded seat lifetimes. */
  ticketRevision(ticketId:string):number|null {
    if(this.state?.lifecycle!=='active')return null;
    return this.state.tickets.find(ticket=>ticket.id===ticketId)?.revision??(this.state.closure?.id===ticketId?this.state.closure.revision:null);
  }
  visible(caller:Caller):boolean {
    if(this.closed||!this.main)return false;
    if(caller.kind==='main')return caller.agentId===this.main.agentId&&caller.sessionId===this.main.sessionId;
    return this.state?.lifecycle==='active'&&(this.state.tickets.some(ticket=>ticket.id===caller.ticketId)||this.state.closure?.id===caller.ticketId);
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.tail.then(work);this.tail=result.then(()=>{},()=>{});return result;}
  private async flush():Promise<Result<null,RuntimeError>> {
    if(!this.pending)return {ok:true,value:null};
    const result=await this.options.files.save(this.pending.expected,this.pending.state);
    if(!result.ok)return {ok:false,error:{kind:'storage',error:result.error}};
    this.state=this.pending.state;this.pending=null;this.options.onChange();
    if(this.state.lifecycle==='active'&&!this.timer&&!this.closed){
      this.timer=setInterval(()=>{void this.run().catch(error=>this.unexpected(error));},this.options.intervalSeconds*1000);this.timer.unref();
    }
    if(this.state.lifecycle==='completed'){clearInterval(this.timer??undefined);this.timer=null;}
    return {ok:true,value:null};
  }
  private async save(state:Agenda,expected:number|null):Promise<Result<null,RuntimeError>> {
    if(this.pending)throw new Error('Unresolved durable write must be flushed before a new transition');
    // Every transition passes here, so a ticket's entry into Done queues its Status write in the same durable save.
    if(this.options.pm&&this.state)statusOnDone(this.state,state,this.options.pm.context);
    this.pending={state,expected};return this.flush();
  }
  private view():Result<ControllerOutput,RuntimeError> {
    if(!this.state)return domain('notFound','No agenda is attached');
    const state=this.state,host=this.options.host;
    const ticketRoles=ticketSeatRoles(state.workflow),parentRoles=parentSeatRoles(state.workflow);
    const seated=[...state.tickets.map(ticket=>({ticketId:ticket.id,roles:ticketRoles})),...(state.closure?[{ticketId:state.closure.id,roles:parentRoles}]:[])]
      .map(({ticketId,roles})=>({ticketId,roles:roles.filter(role=>host.active(ticketId,role))})).filter(item=>item.roles.length>0);
    const asking=state.tickets.flatMap(ticket=>ticket.ask?[{ticketId:ticket.id,question:ticket.ask.question,comment:ticket.ask.comment}]:[]);
    return {ok:true,value:{agenda:structuredClone(state),launchable:state.tickets.filter(ticket=>awaitsLaunch(state,ticket)).map(ticket=>ticket.id),asking,seated}};
  }
  async startup(caller:Caller):Promise<Result<ControllerOutput,RuntimeError>> {
    if(caller.kind!=='main'||!this.visible(caller))return domain('unauthorized','Only the native coordinator may inspect saved agendas');
    const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
    return {ok:true,value:{active:list.value.filter(state=>state.lifecycle==='active').map(state=>state.id)}};
  }
  async execute(caller:Caller,operation:PortInput):Promise<Result<ControllerOutput,RuntimeError>> {
    return this.serial(async()=>{
      const flushed=await this.flush();if(!flushed.ok)return flushed;
      if(!this.visible(caller))return domain('unauthorized','Caller is not a native session of this coordinator');
      if(operation.op==='convene'||operation.op==='resume'){
        if(caller.kind!=='main')return domain('unauthorized','Only Main may attach an agenda');
        if(this.state?.lifecycle==='active')return domain('ownershipBlocked','A live agenda is already attached');
        const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
        const active=list.value.filter(state=>state.lifecycle==='active');
        const self=await this.options.process.current();if(!self.ok)return {ok:false,error:{kind:'process',error:self.error}};
        const run={kind:'attached',id:this.runId,mainAgentId:caller.agentId,mainSessionId:caller.sessionId,pid:self.value.pid,startedAt:self.value.startedAt} as const;
        if(operation.op==='convene'){
          if(active.length)return domain('ownershipBlocked','Resume the saved active agenda instead of creating a second owner');
          const workflow=await this.options.workflow();if(!workflow.ok)return {ok:false,error:{kind:'workflow',error:workflow.error}};
          // The workflow is frozen for the agenda's whole life, so a seat agent that cannot run is refused before it is.
          const agents=await this.options.host.agents(this.options.cwd,workflowAgents(workflow.value));
          if(!agents.ok)return {ok:false,error:{kind:'host',error:agents.error}};
          const facts=await this.source.read(null,operation,'convene');if(!facts.ok)return {ok:false,error:{kind:'source',error:facts.error}};
          const created=createAgenda(operation,workflow.value,facts.value,Date.now(),randomUUID());if(!created.ok)return {ok:false,error:{kind:'domain',error:created.error}};
          created.value.run=run;
          const saved=await this.save(created.value,null);if(!saved.ok)return saved;
        }else{
          if(active.length!==1||active[0]?.id!==operation.agenda)return domain('ownershipBlocked','Exactly one matching saved active agenda is required');
          const saved=await this.options.files.load(operation.agenda);if(!saved.ok)return {ok:false,error:{kind:'storage',error:saved.error}};
          // The OS names a live holder: the same pid with the same start time. A reused pid has another start time.
          const holder=saved.value.run;
          if(holder.kind==='attached'){
            const now=await this.options.process.start(holder.pid);if(!now.ok)return {ok:false,error:{kind:'process',error:now.error}};
            if(now.value.kind==='running'&&now.value.startedAt===holder.startedAt)return domain('agenda_attached',`Agenda ${operation.agenda} is held by coordinator process pid ${holder.pid} started ${holder.startedAt}, which is still running`);
          }
          const next=saved.value;next.version++;next.run=run;
          // A durable executing intent after a restart is never called again, unless its callee accepts a repeat.
          for(const effect of next.effects)if(effect.state.kind==='executing'){
            if(REPLAYABLE[effect.action.kind])effect.state={kind:'ready'};
            else failEffect(next,effect,{kind:'uncertainOutcome',message:'Previous process ended after executing intent; source reconciliation required'},true,Date.now());
          }
          const committed=await this.save(next,saved.value.version-1);if(!committed.ok)return committed;
        }
        this.kick();return this.view();
      }
      if(!this.state)return domain('notFound','Convene or resume an agenda first');
      if(operation.op==='read'){
        if(caller.kind==='seat'&&caller.ticketId!==operation.ticketId)return domain('unauthorized','A seat can read only its bound ticket');
        const ticket=this.state.tickets.find(ticket=>ticket.id===operation.ticketId)??(this.state.closure?.id===operation.ticketId?this.state.closure:null);
        return ticket?{ok:true,value:{ticket:structuredClone(ticket)}}:domain('notFound','Unknown ticket');
      }
      if(operation.op==='status'||operation.op==='tickets'){
        if(caller.kind!=='main')return domain('unauthorized','A seat reads its one ticket with read');
        return this.view();
      }
      const fresh=await this.source.read(this.state,operation,operation.op);if(!fresh.ok)return {ok:false,error:{kind:'source',error:fresh.error}};
      const settled=await this.settle(fresh.value);if(!settled.ok)return settled;
      if(operation.op==='finish'||operation.op==='resolve'&&operation.remove?.length){
        const retiring=operation.op==='finish'?this.state.tickets:this.state.tickets.filter(ticket=>operation.remove?.includes(ticket.id));
        const ticketRoles=ticketSeatRoles(this.state.workflow),closure=this.state.closure;
        const live=retiring.some(ticket=>ticketRoles.some(role=>this.options.host.active(ticket.id,role)));
        if(live||operation.op==='finish'&&closure&&parentSeatRoles(this.state.workflow).some(role=>this.options.host.active(closure.id,role)))return domain('ownershipBlocked','Wait for retiring one-shot seat jobs to exit before finishing or removing their tickets');
      }
      const changed=applyOperation(this.state,operation,caller,fresh.value,Date.now(),this.options.pm?.context.ask??null);if(!changed.ok)return {ok:false,error:{kind:'domain',error:changed.error}};
      if(operation.op==='finish'){
        const cleaned=await this.options.host.finish(this.state.id);
        if(!cleaned.ok)return {ok:false,error:{kind:'host',error:cleaned.error}};
      }
      const committed=await this.save(changed.value,this.state.version);if(!committed.ok)return committed;
      if(operation.op==='launch'){
        // Launching a ticket seats its current stage at once; later stages follow from the relay.
        const relayed=await this.relay(fresh.value);if(!relayed.ok)return relayed;
        this.kick();return {ok:true,value:{launched:relayed.value}};
      }
      this.kick();
      // A seat's result exposes its own ticket, never the other tickets or effects.
      if(caller.kind==='seat'){
        const ticket=this.state.tickets.find(ticket=>ticket.id===caller.ticketId)??this.state.closure;
        return ticket?{ok:true,value:{ticket:structuredClone(ticket)}}:domain('notFound','Ticket was removed');
      }
      return this.view();
    });
  }
  private async settle(facts:Facts):Promise<Result<null,RuntimeError>> {
    if(!this.state)return {ok:true,value:null};
    const next=structuredClone(this.state);
    reconcile(next,facts,Date.now());
    if(canonical(next)===canonical(this.state))return {ok:true,value:null};
    next.version++;return this.save(next,this.state.version);
  }
  private kick():void {
    if(this.closed||this.scheduled)return;
    this.scheduled=setTimeout(()=>{this.scheduled=null;void this.run().catch(error=>this.unexpected(error));},0);this.scheduled.unref();
  }
  private unexpected(error:unknown):void {this.options.onError({kind:'host',error:{kind:'unavailable',message:error instanceof Error?error.message:String(error)}});}
  /**
   * A seat's exit wakes the relay. An exit without a handoff at a still-current revision escalates the ticket,
   * so a seat that keeps failing reaches Main instead of being relaunched forever.
   */
  seatExited(seat:SeatExit,handedOff:boolean,error:string|null):void {
    if(this.closed)return;
    if(!handedOff)void this.serial(async()=>{
      const flushed=await this.flush();if(!flushed.ok){this.options.onError(flushed.error);return;}
      if(this.closed||this.state?.lifecycle!=='active')return;
      const next=structuredClone(this.state);
      if(!abandonSeat(next,seat.ticketId,seat.role,seat.revision,error??'the session ended without submit, verdict, or escalate',Date.now()))return;
      next.version++;const saved=await this.save(next,this.state.version);if(!saved.ok)this.options.onError(saved.error);
    }).catch(error=>this.unexpected(error));
    this.kick();
  }
  /** The launch input of a due seat, or null when the agenda no longer offers that role. */
  private seatLaunch(ticketId:string,role:Role):SeatLaunch|null {
    const state=this.state;if(!state)return null;
    const seat=currentSeat(state,ticketId,role);if(!seat)return null;
    const ticket=state.tickets.find(ticket=>ticket.id===ticketId),closure=state.closure?.id===ticketId?state.closure:null;
    let workspace:SeatWorkspace,revision:number;
    if(ticket){
      if(!availableRoles(state,ticket).includes(role))return null;
      revision=ticket.revision;
      const gate=ticket.gates[ticket.state],session=ticket.sessions[role];
      // A work seat continues its role's session; a judge checks out exactly the PR head or merge commit its stamp names.
      if(seat.kind==='work')workspace=session?{kind:'fork',sessionFile:session}:{kind:'base',target:ticket.target};
      else if(gate?.stamp.kind==='pullRequest')workspace={kind:'commit',repo:gate.stamp.target.repo,sha:gate.stamp.head,pull:gate.stamp.pr.number};
      else if(gate?.stamp.kind==='mergeCommit')workspace={kind:'commit',repo:gate.stamp.target.repo,sha:gate.stamp.commit,pull:null};
      else return null;
    }else if(closure&&closureRoles(state).includes(role)){
      revision=closure.revision;workspace={kind:'base',target:state.tickets[0]!.target};
    }else return null;
    return {agendaId:state.id,ticketId,revision,role,seat:seat.kind,agent:seat.agent,cwd:this.options.cwd,
      prompt:seatBrief(state,ticketId,seat,this.options.pm?.context.ask??null),ticket:ticket??closure!,workspace};
  }
  /**
   * Seats follow from ticket state alone: every started ticket and the parent closure receive their due seats
   * without Main. A seat is one-shot per revision: once a role has been seated at a revision it is never seated
   * there again, so a seat that ended without a handoff waits for its escalation instead of being replaced.
   * A seat also waits for any live seat of its own role (a superseded revision ends at its next tool boundary);
   * a work seat waits for every seat of its ticket, so a rework fork copies a complete, flushed transcript and owns
   * the checkout alone.
   */
  private async relay(facts:Facts):Promise<Result<SeatHandle[],RuntimeError>> {
    const launched:SeatHandle[]=[],host=this.options.host;
    if(this.closed||this.state?.lifecycle!=='active')return {ok:true,value:launched};
    const due:{ticketId:string;role:Role}[]=[],ticketRoles=ticketSeatRoles(this.state.workflow);
    for(const ticket of this.state.tickets){
      if(!ticket.started)continue;
      for(const role of availableRoles(this.state,ticket)){
        if(host.seated(ticket.id,role,ticket.revision))continue;
        const working=ticketDefinition(this.state.workflow,ticket)?.kind==='work';
        if(working?!ticketRoles.some(live=>host.active(ticket.id,live)):!host.active(ticket.id,role))due.push({ticketId:ticket.id,role});
      }
    }
    const closure=this.state.closure;
    if(closure)for(const role of closureRoles(this.state))if(!host.seated(closure.id,role,closure.revision)&&!host.active(closure.id,role))due.push({ticketId:closure.id,role});
    for(const {ticketId,role} of due){
      // An earlier failed launch may have escalated this ticket.
      const input=this.seatLaunch(ticketId,role);if(!input)continue;
      const result=await host.launch(input);
      if(result.ok){
        launched.push(result.value);
        // A work seat's session now exists, so its id and file can be recorded on the ticket's issue.
        const pm=this.options.pm;
        if(!pm||input.seat!=='work')continue;
        const started=workerStarted(this.state,{ticketId,revision:input.revision,role,sessionId:result.value.sessionId,sessionFile:result.value.sessionFile},pm.context,facts);
        if(!started.ok){this.options.onError({kind:'domain',error:started.error});continue;}
        const saved=await this.save(started.value,this.state.version);if(!saved.ok)return saved;
        continue;
      }
      this.options.onError({kind:'host',error:result.error});
      // A precondition refusal (a seat already live, a host shutting down) is a race, not a broken seat.
      if(result.error.kind==='precondition')continue;
      const next=structuredClone(this.state);
      if(!abandonSeat(next,ticketId,role,input.revision,`launch failed: ${result.error.message}`,Date.now()))continue;
      next.version++;const saved=await this.save(next,this.state.version);if(!saved.ok)return saved;
    }
    return {ok:true,value:launched};
  }
  /** Exposed for deterministic integration driving; the production timer uses the same entry. */
  async run():Promise<void> {
    await this.serial(async()=>{
      const flushed=await this.flush();if(!flushed.ok){this.options.onError(flushed.error);return;}
      if(this.closed||!this.state||this.state.lifecycle!=='active')return;
      const observed=await this.source.read(this.state,null,'refresh');if(!observed.ok){this.options.onError({kind:'source',error:observed.error});return;}
      const settled=await this.settle(observed.value);if(!settled.ok){this.options.onError(settled.error);return;}
      const seated=await this.relay(observed.value);if(!seated.ok){this.options.onError(seated.error);return;}
      const runnable=(effect:Effect):boolean=>{
        if(effect.state.kind!=='ready')return false;
        if(effect.action.kind!=='merge')return true;
        const reference=effect.action.pr;
        const pr=observed.value.prs.find(pr=>sameRef(pr.ref,reference));
        return pr?.mergeable==='yes'&&pr.checks.kind==='passing';
      };
      const effect=this.state.effects.find(effect=>effect.state.kind==='executing')??this.state.effects.find(effect=>effect.state.kind==='uncertain'&&satisfiedResult(this.state!,effect,observed.value))??this.state.effects.find(runnable);
      if(!effect)return;
      const result=await this.drive(effect,observed.value);if(!result.ok){this.options.onError(result.error);return;}
      // A confirmed effect advances the ticket (Reviewing after publish, Verifying after merge); seat its next stage.
      const advanced=await this.relay(observed.value);if(!advanced.ok){this.options.onError(advanced.error);return;}
      if(this.state.effects.some(effect=>runnable(effect)||effect.state.kind==='executing'))this.kick();
    });
  }
  private async drive(effect:Effect,facts:Facts):Promise<Result<null,RuntimeError>> {
    if(!this.state)return domain('notFound','Agenda was detached');
    const confirmed=satisfiedResult(this.state,effect,facts);
    if(confirmed){
      const next=structuredClone(this.state),item=next.effects.find(item=>item.id===effect.id)!;
      confirmEffect(next,item,confirmed,facts,Date.now());next.version++;return this.save(next,this.state.version);
    }
    if(effect.state.kind==='uncertain')return {ok:true,value:null};
    if(effect.state.kind==='executing'){
      const next=structuredClone(this.state),item=next.effects.find(item=>item.id===effect.id)!;
      if(REPLAYABLE[item.action.kind])item.state={kind:'ready'};
      else failEffect(next,item,{kind:'uncertainOutcome',message:'Executing intent has no source-confirmed result; explicit Main resolution is required'},true,Date.now());
      next.version++;return this.save(next,this.state.version);
    }
    const premise=effectPrecondition(this.state,effect,facts);
    if(premise){
      const next=structuredClone(this.state),item=next.effects.find(item=>item.id===effect.id)!;
      failEffect(next,item,{kind:'precondition',message:premise},false,Date.now());next.version++;return this.save(next,this.state.version);
    }
    const executing=structuredClone(this.state),item=executing.effects.find(item=>item.id===effect.id)!;
    item.attempt++;item.state={kind:'executing',startedAt:Date.now()};executing.version++;
    const started=await this.save(executing,this.state.version);if(!started.ok)return started;
    let called:Result<EffectResult|null,PortError>;
    try {called=await this.call(item);}catch(error){called={ok:false,error:{kind:'uncertainOutcome',message:error instanceof Error?error.message:String(error)}};}
    // The callee's own response is the confirmation of a replayable effect; its failure is final, never uncertain.
    if(REPLAYABLE[item.action.kind]){
      const next=structuredClone(this.state),current=next.effects.find(effect=>effect.id===item.id)!;
      if(called.ok&&called.value)confirmEffect(next,current,called.value,facts,Date.now());
      else failEffect(next,current,called.ok?{kind:'invalidResponse',message:'The callee answered without a result'}:called.error,false,Date.now());
      next.version++;return this.save(next,this.state.version);
    }
    const receipt:SourceReceipt|undefined=called.ok&&called.value?{effectId:item.id,result:called.value}:undefined;
    const observed=await this.source.read(this.state,null,'effectConfirmation',receipt);
    const next=structuredClone(this.state),current=next.effects.find(effect=>effect.id===item.id)!;
    const result=observed.ok?satisfiedResult(next,current,observed.value):null;
    if(result&&observed.ok)confirmEffect(next,current,result,observed.value,Date.now());
    else {
      const error:PortError=!observed.ok?observed.error:!called.ok?called.error:{kind:'uncertainOutcome',message:'External call returned without source confirmation'};
      const knownFailure=!called.ok&&['permission','precondition','rateLimited'].includes(called.error.kind);
      failEffect(next,current,error,!knownFailure,Date.now());
    }
    next.version++;return this.save(next,this.state.version);
  }
  private async call(effect:Effect):Promise<Result<EffectResult|null,PortError>> {
    const action=effect.action,github=this.options.github;
    switch(action.kind){
      case 'publishPr':{
        const input={headRepo:action.headRepo,branch:action.branch,head:action.head,target:action.target,title:action.title,body:action.body};
        if(action.pr){const result=await github.editPr(action.pr,input);return result.ok?{ok:true,value:{kind:'published',pr:action.pr}}:result;}
        const result=await github.createPr(input);return result.ok?{ok:true,value:{kind:'published',pr:result.value}}:result;
      }
      case 'merge':{const result=await github.mergePr(action.pr,action.head);return result.ok?{ok:true,value:null}:result;}
      case 'setIssueState':{const result=await github.setIssueOpen(action.issue,action.open);return result.ok?{ok:true,value:null}:result;}
      case 'replaceBody':{const result=await github.editIssueBody(action.issue,action.expectedHash,action.body);return result.ok?{ok:true,value:null}:result;}
      case 'createIssue':{const result=await github.createIssue(action);return result.ok?{ok:true,value:{kind:'created',issue:result.value}}:result;}
      case 'attachChild':{const result=await github.addSubIssue(action.parent,action.child);return result.ok?{ok:true,value:null}:result;}
      case 'rerunChecks':{const result=await github.rerunCheck(action.repo,action.workflowRunId);return result.ok?{ok:true,value:null}:result;}
      case 'comment':{const result=await github.comment(action.issue,action.body);return result.ok?{ok:true,value:{kind:'commented',issue:action.issue,comment:result.value}}:result;}
      case 'setProjectField':{const result=await github.setProjectField(action.issue,action.field,action.option);return result.ok?{ok:true,value:null}:result;}
      case 'requestAnswer':{
        const guardians=this.options.pm?.guardians;
        if(!guardians)return {ok:false,error:{kind:'precondition',message:'PM integration is off, so no intent guardians are configured'}};
        const result=await guardians.requestAnswer({issue:action.issue,comment:action.comment,question:action.question,tier:action.tier});
        return result.ok?{ok:true,value:{kind:'answerRequested',issue:action.issue,comment:action.comment,status:result.value}}:result;
      }
    }
  }
  snapshot():Agenda|null{return this.state?structuredClone(this.state):null;}
  /** The run ends with this process: its seats end first, then the agenda is written back to detached. */
  async shutdown():Promise<void> {
    this.closed=true;clearInterval(this.timer??undefined);clearTimeout(this.scheduled??undefined);this.timer=null;this.scheduled=null;
    await this.tail;await this.options.host.dispose();
    await this.serial(async()=>{
      const flushed=await this.flush();if(!flushed.ok){this.options.onError(flushed.error);return;}
      const state=this.state;if(state?.run.kind!=='attached'||state.run.id!==this.runId)return;
      const next=structuredClone(state);next.version++;next.run={kind:'detached'};
      const saved=await this.save(next,state.version);if(!saved.ok)this.options.onError(saved.error);
    });
  }
}
