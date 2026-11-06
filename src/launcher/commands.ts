import type {Result} from '../domain/model.ts';
import {type LauncherStatus,installLauncher,launcherLogPaths,launcherStatus,uninstallLauncher} from './launch-agent.ts';
import {LAUNCHER_PORT} from './link.ts';
import {tr} from '../i18n.ts';

export function launcherUsage():string {return tr('Usage: omp-dispatch-launcher install | uninstall | status','用法：omp-dispatch-launcher install | uninstall | status');}

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

/**
 * The launcher is a separate local process, so installing it is never part of
 * starting a coordinator: this command is the whole user interface to it.
 */
export async function launcherCommand(args:readonly string[]):Promise<Result<string,string>> {
  const command=args[0]??'status';
  if(command==='install'){
    const result=await installLauncher();
    return result.ok?{ok:true,value:`${tr('Dispatch launcher installed.','调度启动器已安装。')}\n${tr('interpreter:','解释器：')} ${result.value.interpreter}\n${describeLauncher(result.value.status)}`}:{ok:false,error:result.error.message};
  }
  if(command==='uninstall'){
    const result=await uninstallLauncher();
    return result.ok?{ok:true,value:`${tr('Dispatch launcher uninstalled.','调度启动器已卸载。')}\n${describeLauncher(result.value)}`}:{ok:false,error:result.error.message};
  }
  if(command==='status'){
    const result=await launcherStatus();
    return result.ok?{ok:true,value:describeLauncher(result.value)}:{ok:false,error:result.error.message};
  }
  return {ok:false,error:launcherUsage()};
}
