import type {Action,ReadonlyAgenda,ConveneInput,EffectResult,Facts,IssueRef,PortError,PortInput,PrRef,Repo,Result,SourceScope,Target} from '../domain/model.ts';
import {sameRef,sameRepo,targetHead} from '../domain/identity.ts';
import type {GitHubPort} from '../ports/contracts.ts';

export type SourceReceipt={effectId:string;result:EffectResult};
export function createSourceReader(github:GitHubPort) {
  return {async read(state:ReadonlyAgenda|null,operation:PortInput|null,cause:string,receipt?:SourceReceipt):Promise<Result<Facts,PortError>> {
    const scope:SourceScope={issues:[],prs:[],repos:[],branches:[],commits:[],checkRuns:[],creations:[],maintenanceIntents:[]};
    function repo(value:Repo):void {if(!scope.repos.some(item=>sameRepo(item.repo,value)))scope.repos.push({repo:value,bases:[]});}
    function target(value:Target):void {
      repo(value.repo);const item=scope.repos.find(item=>sameRepo(item.repo,value.repo));
      if(item&&!item.bases.includes(value.base))item.bases.push(value.base);
    }
    function issue(value:IssueRef):void {repo(value.repo);if(!scope.issues.some(item=>sameRef(item,value)))scope.issues.push(value);}
    function pr(value:PrRef):void {repo(value.repo);if(!scope.prs.some(item=>sameRef(item,value)))scope.prs.push(value);}
    function branch(value:Repo,name:string):void {repo(value);if(!scope.branches.some(item=>sameRepo(item.repo,value)&&item.name===name))scope.branches.push({repo:value,name});}
    function action(value:Action):void {
      switch(value.kind){
        case 'publishPr':issue(value.issue);target(value.target);branch(value.headRepo,value.branch);if(value.pr)pr(value.pr);break;
        case 'merge':issue(value.issue);target(value.target);pr(value.pr);break;
        case 'setIssueState':case 'replaceBody':case 'comment':case 'setProjectField':case 'requestAnswer':issue(value.issue);break;
        case 'createIssue':repo(value.repo);break;
        case 'attachChild':issue(value.parent);issue(value.child);break;
        case 'rerunChecks':pr(value.pr);scope.checkRuns.push({repo:value.repo,runId:value.workflowRunId});break;
      }
    }
    function result(value:EffectResult):void {
      switch(value.kind){
        case 'published':case 'merged':pr(value.pr);break;
        case 'created':case 'bodyReplaced':case 'issueState':case 'commented':case 'projectFieldSet':case 'answerRequested':issue(value.issue);break;
        case 'attached':issue(value.parent);issue(value.child);break;
        case 'rerun':repo(value.repo);break;
      }
    }
    if(state){
      if(state.parent)issue(state.parent);
      for(const ticket of state.tickets){
        issue(ticket.issue);target(ticket.target);
        if(ticket.pr){branch(ticket.pr.headRepo,ticket.pr.branch);if(ticket.pr.ref)pr(ticket.pr.ref);}
        if(ticket.terminal?.kind==='merged')pr(ticket.terminal.pr);
      }
      for(const effect of state.effects){
        if(effect.state.kind==='cancelled')continue;
        action(effect.action);
        if(effect.state.kind==='confirmed'){
          result(effect.state.result);
          if(effect.action.kind==='publishPr'&&effect.action.pr===null&&effect.state.result.kind==='published')scope.maintenanceIntents?.push({kind:'systemCreated',pr:effect.state.result.pr,effectId:effect.id});
        }
      }
    }
    if(operation?.op==='convene'){
      const input:ConveneInput=operation;
      if(input.parent)issue(input.parent);
      for(const entry of input.tickets){issue(entry.issue);target(entry.target);if(entry.adoptPr)pr(entry.adoptPr);}
    }
    if(operation?.op==='submit'){
      const ticket=state?.tickets.find(ticket=>ticket.id===operation.ticketId);
      if(ticket)branch(ticket.pr?.headRepo??ticket.target.repo,operation.branch);
    }
    if(operation?.op==='resolve'){
      if(operation.adoptPr)pr(operation.adoptPr);
      if(operation.target)target(operation.target);
      for(const entry of operation.add??[]){issue(entry.issue);target(entry.target);if(entry.adoptPr)pr(entry.adoptPr);}
      for(const value of operation.actions??[])action(value);
    }
    if(receipt){
      result(receipt.result);
      const effect=state?.effects.find(effect=>effect.id===receipt.effectId);
      if(effect?.action.kind==='publishPr'&&effect.action.pr===null&&receipt.result.kind==='published')scope.maintenanceIntents?.push({kind:'systemCreated',pr:receipt.result.pr,effectId:effect.id});
    }
    if(state)for(const effect of state.effects){
      if(effect.action.kind==='publishPr'&&effect.action.pr===null&&effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled'){
        const candidates=await github.openPrsByHead(effect.action.headRepo,effect.action.branch,effect.action.target);
        if(!candidates.ok)return candidates;
        for(const candidate of candidates.value)pr(candidate.ref);
      }
    }
    const initial=await github.facts(scope,cause);if(!initial.ok)return initial;
    let facts=initial.value;
    const parent=state?.parent??(operation?.op==='convene'?operation.parent:null);
    const children=parent?facts.issues.find(item=>sameRef(item.ref,parent))?.children??[]:[];
    if(children.some(child=>!scope.issues.some(item=>sameRef(item,child)))){
      for(const child of children)issue(child);
      const expanded=await github.facts(scope,`${cause}:children`);if(!expanded.ok)return expanded;facts=expanded.value;
      if(parent&&facts.issues.find(item=>sameRef(item.ref,parent))?.children.some(child=>!facts.issues.some(item=>sameRef(item.ref,child))))return {ok:false,error:{kind:'unavailable',message:'Parent children changed during the complete read'}};
    }
    async function observeMerge(target:Target,merge:string|null):Promise<Result<null,PortError>> {
      const head=targetHead(facts,target);
      if(merge&&head&&!facts.commits.some(item=>sameRepo(item.repo,target.repo)&&item.ancestor===merge&&item.descendant===head)){
        const contained=await github.contains(target.repo,merge,head);if(!contained.ok)return contained;
        facts.commits.push({repo:target.repo,ancestor:merge,descendant:head,result:contained.value});
      }
      return {ok:true,value:null};
    }
    if(state)for(const ticket of state.tickets){
      const resolution=operation?.op==='resolve'&&operation.ticketId===ticket.id?operation:null;
      const reference=resolution?.adoptPr!==undefined?resolution.adoptPr:ticket.pr?.ref;
      const observed=reference?facts.prs.find(pr=>sameRef(pr.ref,reference)):undefined;
      const merge=observed?.state.kind==='merged'?observed.state.sha:resolution?.adoptPr===null?null:ticket.terminal?.kind==='merged'?ticket.terminal.mergeSha:null;
      const compared=await observeMerge(resolution?.target??ticket.target,merge);if(!compared.ok)return compared;
    }
    const entries=operation?.op==='convene'?operation.tickets:operation?.op==='resolve'?operation.add??[]:[];
    for(const entry of entries){
      const observed=entry.adoptPr?facts.prs.find(pr=>sameRef(pr.ref,entry.adoptPr!)):undefined;
      const compared=await observeMerge(entry.target,observed?.state.kind==='merged'?observed.state.sha:null);if(!compared.ok)return compared;
    }
    if(state)for(const effect of state.effects){
      if(effect.action.kind!=='createIssue'||effect.state.kind==='cancelled')continue;
      const created=await github.issuesCreatedSince(effect.action.repo,state.convenedAt);if(!created.ok)return created;
      for(const candidate of created.value)if(candidate.actor.toLowerCase()===facts.viewer.toLowerCase()&&candidate.title===effect.action.title&&candidate.body===effect.action.body&&!facts.createdIssues.some(item=>sameRef(item.issue,candidate.issue)))facts.createdIssues.push(candidate);
    }
    return {ok:true,value:facts};
  }};
}
