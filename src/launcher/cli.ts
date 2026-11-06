#!/usr/bin/env bun
import {launcherCommand} from './commands.ts';
import {readAppCredentials} from './github-app.ts';
import {serveLauncher} from './server.ts';
import {readLauncherSettings} from './settings.ts';
import {serveWebhook} from './webhook.ts';
import {tr} from '../i18n.ts';

const args=process.argv.slice(2);
if(args[0]==='serve'){
  const log=(entry:Readonly<Record<string,unknown>>):void=>{process.stdout.write(`${JSON.stringify(entry)}\n`);};
  const launcher=await serveLauncher({log});
  console.log(tr(`omp-dispatch launcher serving http://127.0.0.1:${launcher.port}/<owner>/<repo>/issues/<number>?spec=<JSON>`,`调度启动器正在服务 http://127.0.0.1:${launcher.port}/<owner>/<repo>/issues/<number>?spec=<JSON>`));
  // The webhook address is read once, for the listener's lifetime; trigger settings and the App are read per delivery.
  const settings=await readLauncherSettings();
  if(!settings.ok)console.error(tr(`GitHub App webhook listener not started: ${settings.error}`,`未启动 GitHub App webhook 监听器：${settings.error}`));
  else await serveWebhook({...settings.value.webhook,log,registration:readAppCredentials,
    settings:async()=>{const current=await readLauncherSettings();return current.ok?{ok:true,value:current.value.trigger}:current;}});
}else{
  const result=await launcherCommand(args);
  if(result.ok)console.log(result.value);
  else{console.error(result.error);process.exitCode=1;}
}
