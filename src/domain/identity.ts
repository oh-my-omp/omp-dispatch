import {createHash} from 'node:crypto';
import type {Agenda,Facts,IssueRef,Repo,Result,Target} from './model.ts';

export function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export function digest(value:unknown):string{return createHash('sha256').update(canonical(value)).digest('hex');}
export function bodyHash(body:string):string{return createHash('sha256').update(body).digest('hex');}
export function repoKey(repo:Repo):string{return `${repo.owner}/${repo.name}`;}
export function refKey(ref:IssueRef):string{return `${repoKey(ref.repo)}#${ref.number}`;}
/** The launcher, the coordinator and the tool parameter grammar share the published reference grammar. */
const namePattern='[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
export function parseRepoReference(value:string):Result<Repo,string> {
  const match=new RegExp(`^(${namePattern})/(${namePattern})$`).exec(value);
  if(!match)return {ok:false,error:`A repository reference must be <owner>/<repo>, not ${JSON.stringify(value)}`};
  const owner=match[1],name=match[2];
  if(!owner||!name)throw new Error('Repository reference parser invariant');
  return {ok:true,value:{owner,name}};
}
export function parseIssueReference(value:string):Result<IssueRef,string> {
  const match=new RegExp(`^(${namePattern})/(${namePattern})#([1-9][0-9]{0,14})$`).exec(value);
  if(!match)return {ok:false,error:`An issue reference must be <owner>/<repo>#<number>, not ${JSON.stringify(value)}`};
  const owner=match[1],name=match[2],number=match[3];
  if(!owner||!name||!number)throw new Error('Issue reference parser invariant');
  return {ok:true,value:{repo:{owner,name},number:Number(number)}};
}
export function parseTargetReference(value:string):Result<Target,string> {
  const at=value.indexOf('@');
  if(at<0)return {ok:false,error:`A target reference must be <owner>/<repo>@<branch>, not ${JSON.stringify(value)}`};
  const repo=parseRepoReference(value.slice(0,at));
  if(!repo.ok)return repo;
  const base=value.slice(at+1);
  if(base.length===0)return {ok:false,error:`A target reference must name a base branch after @, not ${JSON.stringify(value)}`};
  return {ok:true,value:{repo:repo.value,base}};
}
export function sameRef(a:IssueRef,b:IssueRef):boolean{return refKey(a).toLowerCase()===refKey(b).toLowerCase();}
export function sameRepo(a:Repo,b:Repo):boolean{return repoKey(a).toLowerCase()===repoKey(b).toLowerCase();}
export function sameTarget(a:Target,b:Target):boolean{return sameRepo(a.repo,b.repo)&&a.base===b.base;}
export function exactClosingBody(body:string,issue:IssueRef,defaultRepo:Repo):boolean {
  const matches=[...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|(?:([\w.-]+)\/([\w.-]+))?#(\d+))/gi)];
  const match=matches[0];if(matches.length!==1||!match)return false;
  const repo=match[1]&&match[2]?`${match[1]}/${match[2]}`:match[4]&&match[5]?`${match[4]}/${match[5]}`:repoKey(defaultRepo);
  return repo.toLowerCase()===repoKey(issue.repo).toLowerCase()&&Number(match[3]??match[6])===issue.number;
}
export function nextId(state:Agenda,kind:string):string{return `${state.id}/${kind}/${state.nextId++}`;}
export function targetHead(facts:Facts,target:Target):string|null {
  const base=facts.repos.find(item=>sameRepo(item.repo,target.repo))?.bases.find(item=>item.name===target.base);
  return base?.state.kind==='present'?base.state.head:null;
}
export function contains(facts:Facts,repo:Repo,ancestor:string,descendant:string):boolean {
  return ancestor===descendant||facts.commits.some(item=>sameRepo(item.repo,repo)&&item.ancestor===ancestor&&item.descendant===descendant&&item.result==='contains');
}
