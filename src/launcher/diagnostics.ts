import {tr} from '../i18n.ts';

export type LauncherDiagnostic=
  |{kind:'linkPath'}|{kind:'issuePath'}|{kind:'issueReference';value:string}
  |{kind:'missingSpec'}|{kind:'specJson'}|{kind:'specShape';detail:string}|{kind:'relativeCwd';cwd:string}|{kind:'missingDirectory';cwd:string}
  |{kind:'getOnly'}|{kind:'userNavigation'}|{kind:'unexpected'}|{kind:'listen';port:number;detail:string}
  |{kind:'notMac'}|{kind:'noInterpreter'}|{kind:'bootstrap';detail:string}
  |{kind:'notResponding';port:number;log:string}|{kind:'stillResponding';port:number}
  |{kind:'timeout';command:string;seconds:number}|{kind:'commandFailed'}|{kind:'exitCode';code:number}
  |{kind:'noWindow';cwd:string;detail:string};

export function diagnosticText(error:LauncherDiagnostic):string {
  switch(error.kind){
    case 'linkPath':return tr('The link path must be /<owner>/<repo>/issues/<number>','链接路径必须为 /<owner>/<repo>/issues/<number>');
    case 'issuePath':return tr('The link path must end in /issues/<number>','链接路径必须以 /issues/<number> 结尾');
    case 'issueReference':return tr(`An issue reference must be <owner>/<repo>#<number>, not ${JSON.stringify(error.value)}`,`议题引用必须为 <owner>/<repo>#<number>，不能是 ${JSON.stringify(error.value)}`);
    case 'missingSpec':return tr('The link must carry spec=<JSON {"cwd":"<absolute path>","frontend":{"kind":"<frontend>"}}>','链接必须带有 spec=<JSON {"cwd":"<absolute path>","frontend":{"kind":"<frontend>"}}>');
    case 'specJson':return tr('The link spec is not valid JSON','链接的 spec 不是合法 JSON');
    case 'specShape':return tr(`The link spec does not match {"cwd","frontend"}: ${error.detail}`,`链接的 spec 不符合 {"cwd","frontend"}：${error.detail}`);
    case 'relativeCwd':return tr(`cwd ${error.cwd} is not an absolute path`,`cwd ${error.cwd} 不是绝对路径`);
    case 'missingDirectory':return tr(`cwd ${error.cwd} is not an existing directory`,`cwd ${error.cwd} 不是已存在的目录`);
    case 'getOnly':return tr('Only a GET navigation is accepted','仅接受 GET 导航请求');
    case 'userNavigation':return tr('The request is not a user click: Sec-Fetch-Mode: navigate with Sec-Fetch-User: ?1 is required','此请求不是用户点击：必须同时包含 Sec-Fetch-Mode: navigate 和 Sec-Fetch-User: ?1');
    case 'unexpected':return tr('Unexpected launcher failure','启动器发生意外错误');
    case 'listen':return tr(`Cannot listen on 127.0.0.1:${error.port}: ${error.detail}`,`无法监听 127.0.0.1:${error.port}：${error.detail}`);
    case 'notMac':return tr('The launcher is installed as a macOS LaunchAgent; this host is not macOS','启动器通过 macOS LaunchAgent 安装；当前宿主不是 macOS');
    case 'noInterpreter':return tr('Neither bun nor node answers on PATH, so the launcher has no interpreter to install','PATH 中没有可用的 bun 或 node，无法为启动器安装解释器');
    case 'bootstrap':return tr(`launchctl bootstrap failed: ${error.detail}`,`launchctl bootstrap 失败：${error.detail}`);
    case 'notResponding':return tr(`The LaunchAgent loaded but nothing answers on 127.0.0.1:${error.port}; see ${error.log}`,`LaunchAgent 已加载，但 127.0.0.1:${error.port} 没有响应；请查看 ${error.log}`);
    case 'stillResponding':return tr(`The LaunchAgent was removed but 127.0.0.1:${error.port} still answers; another launcher process is running`,`LaunchAgent 已移除，但 127.0.0.1:${error.port} 仍有响应；另一个启动器进程正在运行`);
    case 'timeout':return tr(`${error.command} did not finish within ${error.seconds} seconds`,`${error.command} 未在 ${error.seconds} 秒内完成`);
    case 'commandFailed':return tr('The command failed','命令执行失败');
    case 'exitCode':return tr(`exit code ${error.code}`,`退出码 ${error.code}`);
    case 'noWindow':return tr(`tern ${error.cwd} (no window): ${error.detail}`,`tern ${error.cwd}（无窗口）：${error.detail}`);
  }
}
