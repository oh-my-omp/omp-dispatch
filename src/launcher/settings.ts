import {homedir} from 'node:os';
import {getPluginSettings} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/loader';
import type {Result} from '../domain/model.ts';
import {LAUNCHER_PORT} from './link.ts';
import type {TriggerSettings} from './trigger.ts';

export type WebhookAddress={host:string;port:number};
export type LauncherSettings={trigger:TriggerSettings;webhook:WebhookAddress};
export type ConfigCheckAddress={host:string;port:number};

const DEFAULT_ASSOCIATIONS=['OWNER','MEMBER','COLLABORATOR'];
const DEFAULT_WEBHOOK_PORT=47592;
const DEFAULT_CONFIG_CHECK_PORT=47593;

function list(value:string):string[] {return value.split(',').map(item=>item.trim()).filter(item=>item.length>0);}

function invalid(raw:Readonly<Record<string,unknown>>,key:string,expected:string):{ok:false;error:string} {
  return {ok:false,error:`omp-dispatch.${key} must be ${expected}, not ${JSON.stringify(raw[key])}`};
}

/**
 * A TCP port setting. `omp plugin config set` stores every value as a string, so a plain decimal string is read as its
 * number; anything else (a sign, a fraction, a suffix, an empty value) is not a port.
 */
function portValue(value:unknown):number|null {
  const number=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value.trim())?Number(value.trim()):null;
  return number!==null&&Number.isInteger(number)&&number>=1&&number<=65535?number:null;
}

/** The omp-dispatch plugin settings the launcher reads, with the defaults package.json declares. */
export function parseLauncherSettings(raw:Readonly<Record<string,unknown>>):Result<LauncherSettings,string> {
  const mode=raw.githubTrigger??'link';
  if(mode!=='link'&&mode!=='label')return invalid(raw,'githubTrigger','"link" or "label"');
  const labels=raw.githubTriggerLabels??'';
  if(typeof labels!=='string')return invalid(raw,'githubTriggerLabels','a comma-separated string');
  const associations=raw.githubTriggerAssociations===undefined?DEFAULT_ASSOCIATIONS:typeof raw.githubTriggerAssociations==='string'?list(raw.githubTriggerAssociations):null;
  if(associations===null||associations.length===0)return invalid(raw,'githubTriggerAssociations','a nonempty comma-separated list of author associations');
  const host=raw.webhookHost??'127.0.0.1';
  if(typeof host!=='string'||host.trim().length===0)return invalid(raw,'webhookHost','a nonempty host');
  const port=portValue(raw.webhookPort??DEFAULT_WEBHOOK_PORT);
  if(port===null||port===LAUNCHER_PORT)return invalid(raw,'webhookPort',`a TCP port other than ${LAUNCHER_PORT}`);
  return {ok:true,value:{trigger:{mode,labels:list(labels),associations},webhook:{host:host.trim(),port}}};
}

/**
 * The Meerkat configuration check listener's address. It is parsed apart from the launcher settings so an invalid
 * value disables only this listener; it must differ from the link port and from the webhook port.
 */
export function parseConfigCheckSettings(raw:Readonly<Record<string,unknown>>):Result<ConfigCheckAddress,string> {
  const host=raw.configCheckHost??'127.0.0.1';
  if(typeof host!=='string'||host.trim().length===0)return invalid(raw,'configCheckHost','a nonempty host');
  const port=portValue(raw.configCheckPort??DEFAULT_CONFIG_CHECK_PORT);
  const webhookPort=portValue(raw.webhookPort??DEFAULT_WEBHOOK_PORT);
  if(port===null||port===LAUNCHER_PORT||port===webhookPort)
    return invalid(raw,'configCheckPort',`a TCP port other than ${LAUNCHER_PORT} and the webhook port`);
  return {ok:true,value:{host:host.trim(),port}};
}

/**
 * The launcher is a separate process from omp, so it reads the same store
 * `/settings` and `omp plugin config` write; the home directory as cwd keeps a
 * project's plugin-overrides.json out of a machine-wide listener.
 */
export async function readLauncherSettings():Promise<Result<LauncherSettings,string>> {
  return parseLauncherSettings(await getPluginSettings('omp-dispatch',homedir()));
}

export async function readConfigCheckSettings():Promise<Result<ConfigCheckAddress,string>> {
  return parseConfigCheckSettings(await getPluginSettings('omp-dispatch',homedir()));
}
