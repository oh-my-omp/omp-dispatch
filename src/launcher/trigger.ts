import {z} from '@oh-my-pi/omptype/zod';
import {refKey,sameRef} from '../domain/identity.ts';
import type {IssueRef} from '../domain/model.ts';
import {type LaunchTarget,launcherLinks,resolveTarget} from './link.ts';

/**
 * `link`: a valid launcher link for the issue is enough. `label`: the link and
 * a matching label are both required. `labels` empty means any label;
 * `associations` lists the issue author associations GitHub reports
 * (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, ...) that may start a coordinator.
 */
export type TriggerSettings={mode:'link'|'label';labels:readonly string[];associations:readonly string[]};
export type TriggerDecision={kind:'launch';target:LaunchTarget}|{kind:'ignored';reason:string};

/** The fields of an `issues` delivery the decision reads; GitHub sends many more. */
const issuesEvent=z.object({
  action:z.string(),
  issue:z.object({
    number:z.number().int().positive(),state:z.string(),body:z.string().nullable(),author_association:z.string(),
    labels:z.array(z.object({name:z.string()})),
  }),
  repository:z.object({name:z.string(),owner:z.object({login:z.string()})}),
  label:z.object({name:z.string()}).optional(),
  changes:z.object({body:z.object({from:z.string()}).optional()}).optional(),
});

type Snapshot={body:string;labels:readonly string[]};
type Holds={kind:'holds';target:LaunchTarget}|{kind:'missing';reason:string};

const ignored=(reason:string):TriggerDecision=>({kind:'ignored',reason});

function labelMatches(snapshot:Snapshot,settings:TriggerSettings):boolean {
  if(settings.labels.length===0)return snapshot.labels.length>0;
  const wanted=new Set(settings.labels.map(label=>label.toLowerCase()));
  return snapshot.labels.some(label=>wanted.has(label.toLowerCase()));
}

/** The first launcher link in the body that names this very issue and resolves. */
async function linkedTarget(body:string,issue:IssueRef):Promise<Holds> {
  const reasons:string[]=[];
  for(const link of launcherLinks(body)){
    const target=await resolveTarget({pathname:link.pathname,search:link.search});
    if(!target.ok){reasons.push(target.error.reason);continue;}
    if(!sameRef(target.value.issue,issue)){reasons.push(`the link names ${target.value.reference}, not ${refKey(issue)}`);continue;}
    return {kind:'holds',target:target.value};
  }
  return {kind:'missing',reason:reasons.length?reasons.join('; '):`no launcher link for ${refKey(issue)}`};
}

async function holds(snapshot:Snapshot,issue:IssueRef,settings:TriggerSettings):Promise<Holds> {
  if(settings.mode==='label'&&!labelMatches(snapshot,settings))
    return {kind:'missing',reason:settings.labels.length?`no label among ${settings.labels.join(', ')}`:'no label'};
  return linkedTarget(snapshot.body,issue);
}

/**
 * A coordinator starts on the event that makes the trigger condition true, not
 * on every event while it holds: a title edit or an unrelated label on an
 * issue that already qualified starts nothing. The snapshot before the event
 * comes from the delivery itself (`changes.body.from`, the label just added).
 */
export async function decideIssuesEvent(payload:unknown,settings:TriggerSettings):Promise<TriggerDecision> {
  const read=issuesEvent.safeParse(payload);
  if(!read.success)return ignored(`not an issues delivery: ${read.error.message}`);
  const event=read.data;
  const issue:IssueRef={repo:{owner:event.repository.owner.login,name:event.repository.name},number:event.issue.number};
  const now:Snapshot={body:event.issue.body??'',labels:event.issue.labels.map(label=>label.name)};
  let before:Snapshot|null;
  switch(event.action){
    case 'opened':case 'reopened':before=null;break;
    case 'edited':before={body:event.changes?.body?.from??now.body,labels:now.labels};break;
    case 'labeled':{const added=event.label?.name;before={body:now.body,labels:now.labels.filter(label=>label!==added)};break;}
    default:return ignored(`action ${event.action} does not start a coordinator`);
  }
  if(event.issue.state!=='open')return ignored(`${refKey(issue)} is ${event.issue.state}`);
  const association=event.issue.author_association.toUpperCase();
  if(!settings.associations.some(allowed=>allowed.toUpperCase()===association))
    return ignored(`author association ${association} is not among ${settings.associations.join(', ')}`);
  const after=await holds(now,issue,settings);
  if(after.kind==='missing')return ignored(after.reason);
  if(before&&(await holds(before,issue,settings)).kind==='holds')return ignored(`the trigger already held for ${refKey(issue)} before this ${event.action} event`);
  return {kind:'launch',target:after.target};
}
