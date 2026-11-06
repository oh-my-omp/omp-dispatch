import type {Result} from '../domain/model.ts';
import {type AppRegistration,WEBHOOK_PATH,credentialsPath,defaultAppName,readAppCredentials,registerApp} from './github-app.ts';
import {type LauncherStatus,installLauncher,launcherLogPaths,launcherStatus,portAnswers,uninstallLauncher} from './launch-agent.ts';
import {LAUNCHER_PORT} from './link.ts';
import {type WebhookAddress,readLauncherSettings} from './settings.ts';
import {tr} from '../i18n.ts';

export function launcherUsage():string {
  return tr(
    'Usage: omp-dispatch-launcher install | uninstall | status | github-app register --webhook-url <https URL> [--org <organization>] [--name <app name>]',
    '用法：omp-dispatch-launcher install | uninstall | status | github-app register --webhook-url <https URL> [--org <organization>] [--name <app name>]');
}

export function describeLauncher(state:LauncherStatus):string {
  const logs=launcherLogPaths();
  const yes=tr('yes','是'),no=tr('no','否');
  return [
    tr(`installed: ${state.installed?yes:no} (${state.plist})`,`已安装：${state.installed?yes:no}（${state.plist}）`),
    tr(`launchd loaded: ${state.loaded?yes:no}`,`launchd 已加载：${state.loaded?yes:no}`),
    tr(`127.0.0.1:${LAUNCHER_PORT} answering: ${state.responding?yes:no}`,`127.0.0.1:${LAUNCHER_PORT} 有响应：${state.responding?yes:no}`),
    tr(`logs: ${logs.out}, ${logs.err}`,`日志：${logs.out}，${logs.err}`),
  ].join('\n');
}

export function describeGitHubApp(registration:Result<AppRegistration,string>,webhook:Result<{address:WebhookAddress;answering:boolean},string>):string {
  const yes=tr('yes','是'),no=tr('no','否');
  const app=!registration.ok?tr(`GitHub App: unreadable (${registration.error})`,`GitHub App：无法读取（${registration.error}）`)
    :registration.value.kind==='absent'?tr(`GitHub App: not registered (${credentialsPath})`,`GitHub App：未注册（${credentialsPath}）`)
    :tr(`GitHub App: ${registration.value.app.slug} (${registration.value.app.htmlUrl})`,`GitHub App：${registration.value.app.slug}（${registration.value.app.htmlUrl}）`);
  const listener=!webhook.ok?tr(`webhook listener: settings invalid (${webhook.error})`,`webhook 监听器：设置无效（${webhook.error}）`)
    :tr(`webhook ${webhook.value.address.host}:${webhook.value.address.port}${WEBHOOK_PATH} answering: ${webhook.value.answering?yes:no}`,`webhook ${webhook.value.address.host}:${webhook.value.address.port}${WEBHOOK_PATH} 有响应：${webhook.value.answering?yes:no}`);
  return [app,listener].join('\n');
}

async function githubAppStatus():Promise<string> {
  const settings=await readLauncherSettings();
  const webhook:Result<{address:WebhookAddress;answering:boolean},string>=settings.ok
    ?{ok:true,value:{address:settings.value.webhook,answering:await portAnswers(500,settings.value.webhook)}}:settings;
  return describeGitHubApp(await readAppCredentials(),webhook);
}

/** `--key value` pairs after the subcommand; a repeated or valueless flag is a usage error. */
function flags(args:readonly string[]):Result<ReadonlyMap<string,string>,string> {
  const found=new Map<string,string>();
  for(let index=0;index<args.length;index+=2){
    const key=args[index],value=args[index+1];
    if(!key?.startsWith('--')||value===undefined||value.startsWith('--')||found.has(key))return {ok:false,error:launcherUsage()};
    found.set(key,value);
  }
  return {ok:true,value:found};
}

/**
 * The launcher is a separate local process, so installing it is never part of
 * starting a coordinator: this command is the whole user interface to it.
 */
export async function launcherCommand(args:readonly string[]):Promise<Result<string,string>> {
  const command=args[0]??'status';
  if(command==='install'){
    const result=await installLauncher();
    return result.ok?{ok:true,value:`${tr('Dispatch launcher installed.','调度启动器已安装。')}\n${tr('interpreter:','解释器：')} ${result.value.interpreter}\n${describeLauncher(result.value.status)}\n${await githubAppStatus()}`}:{ok:false,error:result.error.message};
  }
  if(command==='uninstall'){
    const result=await uninstallLauncher();
    return result.ok?{ok:true,value:`${tr('Dispatch launcher uninstalled.','调度启动器已卸载。')}\n${describeLauncher(result.value)}`}:{ok:false,error:result.error.message};
  }
  if(command==='status'){
    const result=await launcherStatus();
    return result.ok?{ok:true,value:`${describeLauncher(result.value)}\n${await githubAppStatus()}`}:{ok:false,error:result.error.message};
  }
  if(command==='github-app'&&args[1]==='register'){
    const parsed=flags(args.slice(2));
    if(!parsed.ok)return parsed;
    const unknown=[...parsed.value.keys()].filter(key=>!['--webhook-url','--org','--name'].includes(key));
    const webhookUrl=parsed.value.get('--webhook-url');
    if(unknown.length||webhookUrl===undefined)return {ok:false,error:launcherUsage()};
    const registered=await registerApp({webhookUrl,org:parsed.value.get('--org')??null,name:parsed.value.get('--name')??defaultAppName()});
    return registered.ok
      ?{ok:true,value:tr(`GitHub App ${registered.value.slug} registered; credentials written to ${credentialsPath}. Install it at ${registered.value.htmlUrl}/installations/new`,`GitHub App ${registered.value.slug} 已注册，凭据已写入 ${credentialsPath}。请在 ${registered.value.htmlUrl}/installations/new 安装`)}
      :{ok:false,error:registered.error};
  }
  return {ok:false,error:launcherUsage()};
}
