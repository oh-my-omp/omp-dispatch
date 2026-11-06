import {stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from '@oh-my-pi/omptype/zod';
import {parseIssueReference,refKey} from '../domain/identity.ts';
import type {IssueRef,Result} from '../domain/model.ts';
import {diagnosticText} from './diagnostics.ts';
import {type FrontendSpec,frontendSpec} from './frontends.ts';

/**
 * Fixed by the published link contract. A configurable port would invalidate
 * every link already written into an issue, so it is a constant, not a setting.
 */
export const LAUNCHER_PORT=47591;
export const LAUNCHER_ORIGIN=`http://127.0.0.1:${LAUNCHER_PORT}`;

/**
 * The link's `spec` query value: one JSON object, so a frontend's own options
 * travel in the link without widening its path or query grammar.
 */
const linkSpec=z.object({cwd:z.string(),frontend:frontendSpec}).strict();

export type LaunchTarget={issue:IssueRef;reference:string;cwd:string;frontend:FrontendSpec};
export type Rejection={kind:'rejected';reason:string};

export function refuse(reason:string):{ok:false;error:Rejection} {return {ok:false,error:{kind:'rejected',reason}};}

/**
 * Only a user's top-level click may start an agent from a link. Any page can
 * GET `127.0.0.1` through an image, a fetch or a prefetch, and GitHub's
 * `no-referrer-when-downgrade` policy drops Referer on the https→http hop, so
 * the click itself is the authorization the operator gives.
 */
export function isUserNavigation(navigation:{mode:string|undefined;user:string|undefined}):boolean {
  return navigation.mode==='navigate'&&navigation.user==='?1';
}

/** The link's path: `/<owner>/<repo>/issues/<number>`. */
export function parseLinkPath(pathname:string):Result<IssueRef,Rejection> {
  const segments=pathname.split('/').filter(segment=>segment.length>0);
  if(segments.length!==4)return refuse(diagnosticText({kind:'linkPath'}));
  const [owner,repo,kind,number]=segments as [string,string,string,string];
  if(kind!=='issues')return refuse(diagnosticText({kind:'issuePath'}));
  const reference=`${owner}/${repo}#${number}`,issue=parseIssueReference(reference);
  return issue.ok?{ok:true,value:issue.value}:refuse(diagnosticText({kind:'issueReference',value:reference}));
}

/**
 * `cwd` is the coordinator's local checkout and travels in the link. The
 * launcher neither reconciles it with the linked repository nor clones or maps
 * anything: a writer of the link is responsible for its truth, and only its
 * being an existing absolute directory is a precondition for starting a process
 * in it.
 */
export async function resolveTarget(input:{pathname:string;search:string}):Promise<Result<LaunchTarget,Rejection>> {
  const path=parseLinkPath(input.pathname);
  if(!path.ok)return path;
  const raw=new URLSearchParams(input.search).get('spec');
  if(raw===null||raw.length===0)return refuse(diagnosticText({kind:'missingSpec'}));
  let json:unknown;
  try {json=JSON.parse(raw);} catch {return refuse(diagnosticText({kind:'specJson'}));}
  const spec=linkSpec.safeParse(json);
  if(!spec.success)return refuse(diagnosticText({kind:'specShape',detail:spec.error.issues.map(issue=>`${issue.path.join('.')||'spec'}: ${issue.message}`).join('; ')}));
  const {cwd,frontend}=spec.data;
  if(!isAbsolute(cwd))return refuse(diagnosticText({kind:'relativeCwd',cwd}));
  const directory=await stat(cwd).catch(()=>null);
  if(!directory?.isDirectory())return refuse(diagnosticText({kind:'missingDirectory',cwd}));
  return {ok:true,value:{issue:path.value,reference:refKey(path.value),cwd,frontend}};
}

const LINK_PATTERN=new RegExp(`${LAUNCHER_ORIGIN.replaceAll('.','\\.')}/[^\\s()<>"'\\]]+`,'g');

/**
 * Every launcher link written in a text, in order. An issue body carries the
 * link inside a Markdown link, so it ends at whitespace or Markdown/HTML
 * punctuation; `spec` is percent-encoded and contains none of those.
 */
export function launcherLinks(text:string):URL[] {
  return [...text.matchAll(LINK_PATTERN)].flatMap(match=>URL.canParse(match[0])?[new URL(match[0])]:[]);
}
