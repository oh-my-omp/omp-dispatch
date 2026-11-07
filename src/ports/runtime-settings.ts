import {join,resolve} from 'node:path';
import {getAgentDir} from '@oh-my-pi/pi-coding-agent';
import {getPluginSettings} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/loader';
import type {Result} from '../domain/model.ts';

/** The coordinator's own settings, resolved against its working directory; `pm` is null with PM integration off. */
export type RuntimeSettings={dataDir:string;intervalSeconds:number;pm:string|null};

const DEFAULT_INTERVAL_SECONDS=120;
/** The native timer's 32-bit millisecond limit, in whole seconds. */
const MAX_INTERVAL_SECONDS=2_147_483;

/** The environment variable, when present (even empty), overrides the plugin setting, as `OMP_DISPATCH_WORKFLOW` does. */
function pick(raw:Readonly<Record<string,unknown>>,env:Readonly<Record<string,string|undefined>>,key:string,variable:string):{source:string;value:unknown} {
  const fromEnv=env[variable];
  return fromEnv!==undefined?{source:variable,value:fromEnv}:{source:`omp-dispatch.${key}`,value:raw[key]};
}

function invalid(picked:{source:string;value:unknown},expected:string):{ok:false;error:string} {
  return {ok:false,error:`${picked.source} must be ${expected}, not ${JSON.stringify(picked.value)}`};
}

/**
 * Whole seconds within the native timer range. `omp plugin config set` stores every value as a string and the
 * environment is text, so a plain decimal string is read as its number; a sign, fraction, or suffix is not.
 */
function wholeSeconds(value:unknown):number|null {
  const number=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value.trim())?Number(value.trim()):null;
  return number!==null&&Number.isSafeInteger(number)&&number>=1&&number<=MAX_INTERVAL_SECONDS?number:null;
}

/** The omp-dispatch plugin settings the coordinator reads at start, with the defaults package.json declares. */
export function parseRuntimeSettings(raw:Readonly<Record<string,unknown>>,env:Readonly<Record<string,string|undefined>>,cwd:string,defaultDataDir:string):Result<RuntimeSettings,string> {
  const data=pick(raw,env,'dataDir','OMP_DISPATCH_DIR');
  const dataDir=data.value??defaultDataDir;
  if(typeof dataDir!=='string'||!dataDir.trim())return invalid(data,'a nonempty path');
  const interval=pick(raw,env,'recomputeIntervalSeconds','OMP_DISPATCH_RECOMPUTE_SECONDS');
  const intervalSeconds=wholeSeconds(interval.value??DEFAULT_INTERVAL_SECONDS);
  if(intervalSeconds===null)return invalid(interval,`whole seconds from 1 to ${MAX_INTERVAL_SECONDS}`);
  const pm=pick(raw,env,'pmConfigDir','OMP_DISPATCH_PM_CONFIG');
  const pmDir=pm.value??'';
  if(typeof pmDir!=='string')return invalid(pm,'a path string');
  return {ok:true,value:{dataDir:resolve(cwd,dataDir),intervalSeconds,pm:pmDir.trim()?resolve(cwd,pmDir.trim()):null}};
}

/** Reads the store `/settings` and `omp plugin config` write, with the coordinator's project overrides. */
export async function readRuntimeSettings(cwd:string):Promise<Result<RuntimeSettings,string>> {
  return parseRuntimeSettings(await getPluginSettings('omp-dispatch',cwd),process.env,cwd,join(getAgentDir(),'omp-dispatch'));
}
