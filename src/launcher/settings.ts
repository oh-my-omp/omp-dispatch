import {homedir} from 'node:os';
import {getPluginSettings} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/loader';
import type {Result} from '../domain/model.ts';
import {LAUNCHER_PORT} from './link.ts';
import type {TriggerSettings} from './trigger.ts';

export type WebhookAddress={host:string;port:number};
export type LauncherSettings={trigger:TriggerSettings;webhook:WebhookAddress};

const DEFAULT_ASSOCIATIONS=['OWNER','MEMBER','COLLABORATOR'];
const DEFAULT_WEBHOOK_PORT=47592;

function list(value:string):string[] {return value.split(',').map(item=>item.trim()).filter(item=>item.length>0);}

/** The omp-dispatch plugin settings the launcher reads, with the defaults package.json declares. */
export function parseLauncherSettings(raw:Readonly<Record<string,unknown>>):Result<LauncherSettings,string> {
  const fail=(key:string,expected:string):{ok:false;error:string}=>({ok:false,error:`omp-dispatch.${key} must be ${expected}, not ${JSON.stringify(raw[key])}`});
  const mode=raw.githubTrigger??'link';
  if(mode!=='link'&&mode!=='label')return fail('githubTrigger','"link" or "label"');
  const labels=raw.githubTriggerLabels??'';
  if(typeof labels!=='string')return fail('githubTriggerLabels','a comma-separated string');
  const associations=raw.githubTriggerAssociations===undefined?DEFAULT_ASSOCIATIONS:typeof raw.githubTriggerAssociations==='string'?list(raw.githubTriggerAssociations):null;
  if(associations===null||associations.length===0)return fail('githubTriggerAssociations','a nonempty comma-separated list of author associations');
  const host=raw.webhookHost??'127.0.0.1';
  if(typeof host!=='string'||host.trim().length===0)return fail('webhookHost','a nonempty host');
  const port=raw.webhookPort??DEFAULT_WEBHOOK_PORT;
  if(typeof port!=='number'||!Number.isInteger(port)||port<1||port>65535||port===LAUNCHER_PORT)return fail('webhookPort',`a TCP port other than ${LAUNCHER_PORT}`);
  return {ok:true,value:{trigger:{mode,labels:list(labels),associations},webhook:{host:host.trim(),port}}};
}

/**
 * The launcher is a separate process from omp, so it reads the same store
 * `/settings` and `omp plugin config` write; the home directory as cwd keeps a
 * project's plugin-overrides.json out of a machine-wide listener.
 */
export async function readLauncherSettings():Promise<Result<LauncherSettings,string>> {
  return parseLauncherSettings(await getPluginSettings('omp-dispatch',homedir()));
}