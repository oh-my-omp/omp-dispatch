import {z} from '@oh-my-pi/omptype/zod';
import {type Runner,run} from './exec.ts';
import type {CoordinatorTarget,LaunchOutcome} from './frontends.ts';
import {diagnosticText} from './diagnostics.ts';
import {tr} from '../i18n.ts';

/** `{"kind":"tern"}`: Tern takes no options yet; unknown fields are refused rather than ignored. */
export const ternSpec=z.object({kind:z.literal('tern')}).strict();

/** `tern ls --json`, read only where a block can carry a coordinator command; every other field is ignored. */
const listingSchema=z.object({
  sessions:z.array(z.object({
    tabs:z.array(z.object({
      blocks:z.array(z.object({id:z.number(),live:z.boolean().optional(),exited:z.number().nullable().optional(),args:z.array(z.string()).optional()})),
    })),
  })),
});

/** `tern inspect --json`, read only for the connected clients; everything else is ignored. */
const inspectionSchema=z.object({clients:z.array(z.object({kind:z.string().optional()}))});

function describe(result:{code:number;stdout:string;stderr:string}):string {return result.stderr.trim()||result.stdout.trim()||diagnosticText({kind:'exitCode',code:result.code});}

/** Tern launches every block as `<shell> -c "<command>"`, so one launcher argument arrives as a fragment of one array entry; compare whitespace-separated, unquoted tokens rather than raw entries. */
function coordinatorTokens(args:readonly string[]):string[] {
  return args.flatMap(value=>value.split(/\s+/)).map(token=>token.replace(/^["']|["']$/g,'')).filter(token=>token.length>0);
}

/**
 * Tern owns existence: a live block already running the exact reference is the
 * coordinator for that issue. Nothing here keeps its own dedup record, so a
 * coordinator that exited simply stops matching and the next click starts one.
 * Tern keeps a finished command's pane listed as `live` with its exit code, so
 * only a pane that has not exited holds a coordinator.
 */
export function liveCoordinatorBlock(listing:string,reference:string):string|null {
  let parsed:unknown;
  try {parsed=JSON.parse(listing);} catch {return null;}
  const read=listingSchema.safeParse(parsed);
  if(!read.success)return null;
  for(const session of read.data.sessions)for(const tab of session.tabs)for(const block of tab.blocks){
    if(block.live!==true||block.exited!==null&&block.exited!==undefined)continue;
    const tokens=coordinatorTokens(block.args??[]);
    const carries=tokens.some((token,index)=>token==='--dispatch'&&tokens[index+1]===reference)||tokens.includes(`--dispatch=${reference}`);
    if(carries)return String(block.id);
  }
  return null;
}

/**
 * Tern's daemon outlives its window: with the app closed it still lists
 * sessions and accepts a new tab, so a block started then is running but
 * invisible. A connected `window` client is the evidence that a launch is
 * visible to the operator; an unreadable report is not evidence of one.
 */
export function connectedWindow(inspection:string):boolean {
  let parsed:unknown;
  try {parsed=JSON.parse(inspection);} catch {return false;}
  const read=inspectionSchema.safeParse(parsed);
  if(!read.success)return false;
  return read.data.clients.some(client=>client.kind==='window');
}

/**
 * Start or reveal the coordinator for one issue in Tern. `omp` is taken from
 * PATH, as the operator's own shell would resolve it, and the extension arrives
 * through the installed plugin rather than an `-e` flag that would load it twice.
 */
export async function launchTern(target:CoordinatorTarget,exec:Runner=run):Promise<LaunchOutcome> {
  const inspection=await exec('tern',['inspect','--json'],{});
  let listing=await exec('tern',['ls','--json'],{});
  if(listing.code!==0||!connectedWindow(inspection.stdout)){
    const opened=await exec('tern',[target.cwd],{});
    if(opened.code!==0)return {kind:'frontendFailed',output:diagnosticText({kind:'noWindow',cwd:target.cwd,detail:describe(opened)})};
    if(listing.code!==0)listing=await exec('tern',['ls','--json'],{});
  }
  if(listing.code!==0)return {kind:'frontendFailed',output:`tern ls: ${describe(listing)}`};
  const holder=liveCoordinatorBlock(listing.stdout,target.reference);
  if(holder!==null){
    const focused=await exec('tern',['focus',holder],{});
    return focused.code===0?{kind:'existing',detail:tr(`Tern block ${holder} already runs it and is focused now`,`Tern 区块 ${holder} 已在运行它，现已聚焦`)}:{kind:'frontendFailed',output:`tern focus ${holder}: ${describe(focused)}`};
  }
  const tab=await exec('tern',['new','tab','--cwd',target.cwd,'--','omp','--dispatch',target.reference],{});
  return tab.code===0?{kind:'launched'}:{kind:'frontendFailed',output:`tern new tab: ${describe(tab)}`};
}
