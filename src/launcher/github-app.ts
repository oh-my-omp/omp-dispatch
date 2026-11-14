import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {z} from '@oh-my-pi/omptype/zod';
import type {Result} from '../domain/model.ts';
import {type Runner,run} from './exec.ts';
import {tr} from '../i18n.ts';

/** The path GitHub delivers to; a tunnel in front of the webhook listener may restrict ingress to it. */
export const WEBHOOK_PATH='/github/webhook';

/**
 * The App's credentials, written once by the manifest conversion. The
 * launcher owns them: nothing else creates or rotates them, and registering
 * again replaces the file with a new App's credentials.
 */
export const credentialsPath=join(homedir(),'.config','omp-dispatch','github-app.json');

const appCredentials=z.object({
  id:z.number(),slug:z.string(),name:z.string(),owner:z.string(),htmlUrl:z.string(),
  webhookSecret:z.string().min(1),pem:z.string(),clientId:z.string(),clientSecret:z.string(),
}).strict();
export type AppCredentials=z.infer<typeof appCredentials>;
export type AppRegistration={kind:'absent'}|{kind:'present';app:AppCredentials};

export async function readAppCredentials():Promise<Result<AppRegistration,string>> {
  let text:string;
  try {text=await readFile(credentialsPath,'utf8');}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return {ok:true,value:{kind:'absent'}};
    return {ok:false,error:`${credentialsPath}: ${error instanceof Error?error.message:String(error)}`};
  }
  let json:unknown;
  try {json=JSON.parse(text);} catch {return {ok:false,error:`${credentialsPath} is not JSON`};}
  const read=appCredentials.safeParse(json);
  return read.success?{ok:true,value:{kind:'present',app:read.data}}:{ok:false,error:`${credentialsPath}: ${read.error.message}`};
}

/** `POST /app-manifests/{code}/conversions`: only the fields the launcher keeps. */
const conversion=z.object({
  id:z.number(),slug:z.string(),name:z.string(),owner:z.object({login:z.string()}),html_url:z.string(),
  webhook_secret:z.string().min(1),pem:z.string(),client_id:z.string(),client_secret:z.string(),
});

export type RegisterOptions={webhookUrl:string;org:string|null;name:string;runner?:Runner;timeoutMs?:number};

function escapeHtml(value:string):string {
  return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]??character));
}

/** The environment variable that carries the URL into the Windows opener's fixed script. */
const OPEN_URL_ENV='OMP_DISPATCH_OPEN_URL';

/**
 * The command that hands `url` to the default browser: `open` on macOS; on Windows, Windows PowerShell's `Start-Process`, which
 * passes the URL to the shell's protocol handler and exits non-zero when that hand-off fails. PowerShell is named by its System32
 * path, so a program of that name earlier on PATH cannot run instead; the URL reaches the fixed script through the environment, so
 * no shell parses it. omp's own `openPath` does the same hand-off but reports nothing back, and a failed open has to end the
 * registration at once rather than at its timeout.
 */
function browserOpen(url:string):{command:string;args:string[];env:Record<string,string>} {
  if(process.platform!=='win32')return {command:'open',args:[url],env:{}};
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return {command:powershell,args:['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Start-Process $env:${OPEN_URL_ENV}`],env:{[OPEN_URL_ENV]:url}};
}

function page(title:string,body:string):string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

/**
 * GitHub's manifest flow: the browser posts the manifest to GitHub, the
 * operator confirms the App there, and GitHub redirects back with a one-time
 * code that converts into the App's credentials. The callback listener lives
 * only for this registration, on an ephemeral loopback port, and accepts only
 * the `state` it issued.
 */
export async function registerApp(options:RegisterOptions):Promise<Result<AppCredentials,string>> {
  if(!URL.canParse(options.webhookUrl)||new URL(options.webhookUrl).protocol!=='https:')
    return {ok:false,error:tr(`--webhook-url must be an https URL, not ${options.webhookUrl}`,`--webhook-url 必须是 https URL，不能是 ${options.webhookUrl}`)};
  const state=randomUUID();
  const done=Promise.withResolvers<Result<AppCredentials,string>>();
  const server=createServer((request,response)=>{
    const url=new URL(request.url??'/','http://127.0.0.1');
    const reply=(status:number,html:string):void=>{response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(html);};
    if(url.pathname==='/'){
      const port=(server.address() as AddressInfo).port;
      const manifest={
        name:options.name,url:'https://github.com/oh-my-omp/omp-dispatch',description:'omp-dispatch: start a Dispatch coordinator from GitHub issue events',
        hook_attributes:{url:options.webhookUrl,active:true},redirect_url:`http://127.0.0.1:${port}/callback`,public:false,
        default_permissions:{issues:'read'},default_events:['issues'],
      };
      const action=options.org===null?'https://github.com/settings/apps/new':`https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new`;
      reply(200,page(tr('Register the omp-dispatch GitHub App','注册 omp-dispatch GitHub App'),
        `<form id="manifest" method="post" action="${action}?state=${state}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">${tr('Continue on GitHub','前往 GitHub 继续')}</button></form><script>document.getElementById('manifest').submit()</script>`));
      return;
    }
    if(url.pathname!=='/callback'){reply(404,page('404',''));return;}
    const code=url.searchParams.get('code');
    if(url.searchParams.get('state')!==state||!code){reply(400,page(tr('Rejected','已拒绝'),tr('<p>This callback does not belong to the pending registration.</p>','<p>此回调不属于当前的注册流程。</p>')));return;}
    void (async()=>{
      const converted=await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,{method:'POST',headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}});
      const body:unknown=await converted.json().catch(()=>null);
      const read=conversion.safeParse(body);
      if(!converted.ok||!read.success){
        const reason=`GitHub manifest conversion answered ${converted.status}: ${JSON.stringify(body)?.slice(0,500)}`;
        reply(502,page(tr('Registration failed','注册失败'),`<pre>${escapeHtml(reason)}</pre>`));done.resolve({ok:false,error:reason});return;
      }
      const app:AppCredentials={id:read.data.id,slug:read.data.slug,name:read.data.name,owner:read.data.owner.login,htmlUrl:read.data.html_url,
        webhookSecret:read.data.webhook_secret,pem:read.data.pem,clientId:read.data.client_id,clientSecret:read.data.client_secret};
      await mkdir(dirname(credentialsPath),{recursive:true,mode:0o700});
      await writeFile(credentialsPath,`${JSON.stringify(app,null,2)}\n`,{mode:0o600});
      await chmod(credentialsPath,0o600);
      reply(200,page(tr('Registered','已注册'),tr(`<p>GitHub App <code>${escapeHtml(app.slug)}</code> is registered. <a href="${escapeHtml(app.htmlUrl)}/installations/new">Install it</a> on the repositories whose issues may start a coordinator.</p>`,`<p>GitHub App <code>${escapeHtml(app.slug)}</code> 已注册。请把它<a href="${escapeHtml(app.htmlUrl)}/installations/new">安装</a>到允许其议题启动协调者的仓库。</p>`)));
      done.resolve({ok:true,value:app});
    })().catch((error:unknown)=>{
      const reason=error instanceof Error?error.message:String(error);
      reply(502,page(tr('Registration failed','注册失败'),`<pre>${escapeHtml(reason)}</pre>`));done.resolve({ok:false,error:reason});
    });
  });
  const listening=Promise.withResolvers<void>();
  server.once('error',listening.reject);
  server.listen(0,'127.0.0.1',()=>listening.resolve());
  await listening.promise;
  const start=`http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const timer=setTimeout(()=>done.resolve({ok:false,error:tr('The registration was not completed in the browser in time','未在限定时间内于浏览器中完成注册')}),options.timeoutMs??600_000);
  const browser=browserOpen(start);
  const opened=await (options.runner??run)(browser.command,browser.args,{env:browser.env});
  if(opened.code!==0)done.resolve({ok:false,error:tr(`Cannot open ${start}: ${opened.stderr}`,`无法打开 ${start}：${opened.stderr}`)});
  const result=await done.promise;
  clearTimeout(timer);
  server.closeAllConnections();
  const closed=Promise.withResolvers<void>();
  server.close(()=>closed.resolve());
  await closed.promise;
  return result;
}

/** A default App name; GitHub App names are global, so the suffix keeps one operator's re-registrations apart. */
export function defaultAppName():string {return `omp-dispatch-${randomBytes(3).toString('hex')}`;}
