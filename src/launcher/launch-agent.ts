import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import type {Result} from '../domain/model.ts';
import {run} from './exec.ts';
import {LAUNCHER_PORT} from './link.ts';
import {diagnosticText} from './diagnostics.ts';

export const LAUNCHER_LABEL='com.ohmyomp.dispatch-launcher';
const cliPath=fileURLToPath(new URL('./cli.ts',import.meta.url));
const plistPath=join(homedir(),'Library','LaunchAgents',`${LAUNCHER_LABEL}.plist`);
const logPath=(suffix:'out'|'err'):string=>join(homedir(),'Library','Logs',`${LAUNCHER_LABEL}.${suffix}.log`);
const launchctlTarget=`gui/${process.getuid?.()??''}/${LAUNCHER_LABEL}`;

export type LauncherFailure={kind:'unavailable';message:string};
export type LauncherStatus={plist:string;installed:boolean;loaded:boolean;responding:boolean};
export type LauncherReport={status:LauncherStatus;interpreter:string};

function failure(message:string):{ok:false;error:LauncherFailure} {return {ok:false,error:{kind:'unavailable',message}};}

function escapeXml(value:string):string {return value.replace(/[&<>]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[character]??character));}

/**
 * The plist carries the interpreter and the installing PATH, because launchd
 * starts an agent with a minimal environment: neither `bun` nor `omp` would be
 * found by name there, and the recorded PATH is what `omp` resolves through.
 * A `trusted-run` on PATH goes first: launchd makes the program it starts the
 * one macOS privacy checks attribute to, and an interpreter reached through a
 * version manager shim changes path on every upgrade, so its grants are lost.
 */
function plistDocument(interpreter:string,wrapper:string|null):string {
  const program=[...(wrapper?[wrapper]:[]),interpreter,cliPath,'serve'].map(argument=>`<string>${escapeXml(argument)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHER_LABEL}</string>
  <key>ProgramArguments</key><array>${program}</array>
  <key>WorkingDirectory</key><string>${escapeXml(dirname(cliPath))}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(process.env.PATH??'')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logPath('out'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath('err'))}</string>
</dict>
</plist>
`;
}

function onPath(name:string):string|null {
  const found=(process.env.PATH??'').split(':').filter(part=>part.length>0).map(directory=>join(directory,name)).find(candidate=>existsSync(candidate));
  return found??null;
}

function interpreterOnPath():string|null {
  for(const name of ['bun','node'])for(const directory of (process.env.PATH??'').split(':').filter(part=>part.length>0)){
    const candidate=join(directory,name);
    if(!existsSync(candidate))continue;
    if(spawnSync(candidate,['--version'],{stdio:'ignore'}).status===0)return candidate;
  }
  return null;
}

function portAnswers(timeoutMs:number):Promise<boolean> {
  const {promise,resolve}=Promise.withResolvers<boolean>();
  const socket=connect({host:'127.0.0.1',port:LAUNCHER_PORT});
  const settle=(answer:boolean):void=>{socket.destroy();resolve(answer);};
  socket.setTimeout(timeoutMs,()=>settle(false));
  socket.once('connect',()=>settle(true));
  socket.once('error',()=>settle(false));
  return promise;
}

/** A cold interpreter start through a PATH shim can take several seconds, so the installer waits rather than reporting a healthy agent as dead. */
async function waitForPort(patienceMs=20_000):Promise<boolean> {
  const started=Date.now();
  while(Date.now()-started<patienceMs){
    if(await portAnswers(500))return true;
    await delay(300);
  }
  return false;
}

async function launchdLoaded():Promise<boolean> {
  const printed=await run('launchctl',['print',launchctlTarget],{});
  return printed.code===0;
}

async function status():Promise<LauncherStatus> {
  return {plist:plistPath,installed:existsSync(plistPath),loaded:await launchdLoaded(),responding:await portAnswers(500)};
}

/** Idempotent: bootout first so a stale or differently configured agent is replaced. */
export async function installLauncher():Promise<Result<LauncherReport,LauncherFailure>> {
  if(process.platform!=='darwin')return failure(diagnosticText({kind:'notMac'}));
  const interpreter=interpreterOnPath();
  if(!interpreter)return failure(diagnosticText({kind:'noInterpreter'}));
  await mkdir(dirname(plistPath),{recursive:true});
  await mkdir(dirname(logPath('out')),{recursive:true});
  await writeFile(plistPath,plistDocument(interpreter,onPath('trusted-run')),'utf8');
  await run('launchctl',['bootout',launchctlTarget],{});
  const bootstrapped=await run('launchctl',['bootstrap',`gui/${process.getuid?.()??''}`,plistPath],{});
  if(bootstrapped.code!==0)return failure(diagnosticText({kind:'bootstrap',detail:bootstrapped.stderr.trim()||bootstrapped.stdout.trim()}));
  const responding=await waitForPort();
  if(!responding)return failure(diagnosticText({kind:'notResponding',port:LAUNCHER_PORT,log:logPath('err')}));
  return {ok:true,value:{status:{plist:plistPath,installed:true,loaded:true,responding},interpreter}};
}

export async function uninstallLauncher():Promise<Result<LauncherStatus,LauncherFailure>> {
  await run('launchctl',['bootout',launchctlTarget],{});
  await rm(plistPath,{force:true});
  const remaining=await status();
  if(remaining.responding)return failure(diagnosticText({kind:'stillResponding',port:LAUNCHER_PORT}));
  return {ok:true,value:remaining};
}

export async function launcherStatus():Promise<Result<LauncherStatus,LauncherFailure>> {
  return {ok:true,value:await status()};
}

export function launcherLogPaths():{out:string;err:string} {return {out:logPath('out'),err:logPath('err')};}
