import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {type Runner,run} from './exec.ts';
import {LAUNCHER_PORT,isUserNavigation,resolveTarget} from './link.ts';
import {type LaunchOutcome,launchFrontend} from './frontends.ts';
import {language,tr} from '../i18n.ts';
import {diagnosticText} from './diagnostics.ts';

export type LauncherOutcome=LaunchOutcome|{kind:'rejected';reason:string};
export type LauncherOptions={port?:number;runner?:Runner;log?:(entry:Readonly<Record<string,unknown>>)=>void};
export type Launcher={port:number;close:()=>Promise<void>};

function escapeHtml(value:string):string {
  return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]??character));
}

function header(request:IncomingMessage,name:string):string|undefined {
  const value=request.headers[name];
  return Array.isArray(value)?value[0]:value;
}

/** One page per request states the single observable end of that request. */
function renderPage(outcome:LauncherOutcome,url:string):{status:number;title:string;body:string} {
  switch(outcome.kind){
    case 'launched':
      return {status:200,title:tr('launched','已启动'),body:tr(`<p>The frontend is running <code>omp --dispatch</code> for <em>${escapeHtml(url)}</em>.</p>`,`<p>前端已为 <em>${escapeHtml(url)}</em> 运行 <code>omp --dispatch</code>。</p>`)};
    case 'existing':
      return {status:200,title:tr('existing','已存在'),body:tr(`<p>A coordinator for this issue is already running; no second process was started: ${escapeHtml(outcome.detail)}.</p>`,`<p>此议题的协调者已在运行，未启动第二个进程：${escapeHtml(outcome.detail)}。</p>`)};
    case 'rejected':
      return {status:400,title:tr('rejected','已拒绝'),body:tr(`<p>Nothing was started: ${escapeHtml(outcome.reason)}.</p>`,`<p>未启动任何进程：${escapeHtml(outcome.reason)}。</p>`)};
    case 'frontendFailed':
      return {status:502,title:tr('frontendFailed','前端失败'),body:`<p>${tr('The frontend could not start the coordinator.','前端无法启动协调者。')}</p><pre>${escapeHtml(outcome.output)}</pre>`};
  }
}

function pageDocument(page:{title:string;body:string}):string {
  return `<!doctype html><html lang="${language()}"><head><meta charset="utf-8"><title>${tr('omp-dispatch launcher','调度启动器')}: ${escapeHtml(page.title)}</title></head><body><h1>${escapeHtml(page.title)}</h1>${page.body}</body></html>`;
}

export async function serveLauncher(options:LauncherOptions={}):Promise<Launcher> {
  const port=options.port??LAUNCHER_PORT;
  const runner=options.runner??run;
  const log=options.log??((entry)=>{process.stdout.write(`${JSON.stringify(entry)}\n`);});

  const handle=async(request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    const url=new URL(request.url??'/',`http://127.0.0.1:${port}`);
    const navigation={mode:header(request,'sec-fetch-mode'),user:header(request,'sec-fetch-user')};
    const received={at:new Date().toISOString(),method:request.method??null,url:request.url??null,
      secFetchMode:navigation.mode??null,secFetchUser:navigation.user??null,referer:header(request,'referer')??null,userAgent:header(request,'user-agent')??null};
    let outcome:LauncherOutcome;
    let reference:string|null=null;
    if(request.method!=='GET')outcome={kind:'rejected',reason:diagnosticText({kind:'getOnly'})};
    else if(!isUserNavigation(navigation))outcome={kind:'rejected',reason:diagnosticText({kind:'userNavigation'})};
    else {
      const target=await resolveTarget({pathname:url.pathname,search:url.search});
      if(!target.ok)outcome=target.error;
      else {reference=target.value.reference;outcome=await launchFrontend(target.value.frontend,target.value,runner);}
    }
    const page=renderPage(outcome,request.url??'/');
    log({...received,reference,outcome:outcome.kind,
      detail:outcome.kind==='rejected'?outcome.reason:outcome.kind==='existing'?outcome.detail:outcome.kind==='frontendFailed'?outcome.output:reference});
    response.writeHead(page.status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end(pageDocument(page));
  };

  const server=createServer((request,response)=>{
    handle(request,response).catch((error:unknown)=>{
      const message=error instanceof Error?error.message:diagnosticText({kind:'unexpected'});
      const page=renderPage({kind:'frontendFailed',output:message},request.url??'/');
      log({at:new Date().toISOString(),url:request.url??null,outcome:'frontendFailed',detail:message});
      response.writeHead(page.status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      response.end(pageDocument(page));
    });
  });
  const listening=Promise.withResolvers<void>();
  const failed=(error:Error):void=>{listening.reject(new Error(diagnosticText({kind:'listen',port,detail:error.message})));};
  server.once('error',failed);
  server.listen(port,'127.0.0.1',()=>{server.off('error',failed);listening.resolve();});
  await listening.promise;
  log({at:new Date().toISOString(),outcome:'listening',port});
  return {port,close:()=>{
    const closed=Promise.withResolvers<void>();
    server.close(error=>error?closed.reject(error):closed.resolve());
    return closed.promise;
  }};
}
