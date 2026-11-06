#!/usr/bin/env bun
import {launcherCommand} from './commands.ts';
import {serveLauncher} from './server.ts';
import {tr} from '../i18n.ts';

const args=process.argv.slice(2);
if(args[0]==='serve'){
  const launcher=await serveLauncher();
  console.log(tr(`omp-dispatch launcher serving http://127.0.0.1:${launcher.port}/tern/<owner>/<repo>/issues/<number>?cwd=<absolute path>`,`调度启动器正在服务 http://127.0.0.1:${launcher.port}/tern/<owner>/<repo>/issues/<number>?cwd=<absolute path>`));
}else{
  const result=await launcherCommand(args);
  if(result.ok)console.log(result.value);
  else{console.error(result.error);process.exitCode=1;}
}
