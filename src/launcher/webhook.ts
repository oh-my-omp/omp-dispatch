import {createHmac,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Result} from '../domain/model.ts';
import {type Runner,run} from './exec.ts';
import {launchFrontend} from './frontends.ts';
import {type AppRegistration,WEBHOOK_PATH} from './github-app.ts';
import {type TriggerSettings,decideIssuesEvent} from './trigger.ts';

export type WebhookOptions={
  host:string;port:number;runner?:Runner;log:(entry:Readonly<Record<string,unknown>>)=>void;
  /** Read per delivery, so registering the App or changing a trigger setting needs no restart. */
  registration:()=>Promise<Result<AppRegistration,string>>;
  settings:()=>Promise<Result<TriggerSettings,string>>;
};
export type WebhookListener={host:string;port:number;close:()=>Promise<void>};

const MAX_BODY=5*1024*1024;

/** GitHub signs the exact delivered bytes with the App's webhook secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function validSignature(secret:string,body:Uint8Array,header:string|undefined):boolean {
  if(!header?.startsWith('sha256='))return false;
  const expected=createHmac('sha256',secret).update(body).digest();
  const given=Buffer.from(header.slice('sha256='.length),'hex');
  return given.length===expected.length&&timingSafeEqual(given,expected);
}

async function readBody(request:IncomingMessage):Promise<Buffer|null> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of request){
    const buffer=chunk as Buffer;size+=buffer.length;
    if(size>MAX_BODY)return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function header(request:IncomingMessage,name:string):string|undefined {
  const value=request.headers[name];
  return Array.isArray(value)?value[0]:value;
}

/**
 * The GitHub App's delivery endpoint, separate from the link listener: a
 * tunnel exposes this port, so it trusts nothing but the HMAC signature, and
 * the link listener stays reachable from this machine only. A delivery is
 * answered once the decision is made; the frontend launch continues after the
 * reply, because GitHub abandons a delivery after ten seconds.
 */
export async function serveWebhook(options:WebhookOptions):Promise<WebhookListener> {
  const runner=options.runner??run;
  const handle=async(request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    const delivery=header(request,'x-github-delivery')??null,event=header(request,'x-github-event')??null;
    const answer=(status:number,outcome:string,detail:string|null,extra:Readonly<Record<string,unknown>>={}):void=>{
      options.log({at:new Date().toISOString(),source:'webhook',delivery,event,outcome,detail,...extra});
      response.writeHead(status,{'content-type':'application/json'});
      response.end(JSON.stringify({outcome,detail}));
    };
    const path=new URL(request.url??'/','http://127.0.0.1').pathname;
    if(request.method!=='POST'||path!==WEBHOOK_PATH){answer(404,'notFound',`${request.method} ${path}`);return;}
    const body=await readBody(request);
    if(body===null){answer(413,'rejected','payload too large');return;}
    const registration=await options.registration();
    if(!registration.ok){answer(500,'unavailable',registration.error);return;}
    if(registration.value.kind==='absent'){answer(503,'unavailable','no GitHub App is registered');return;}
    if(!validSignature(registration.value.app.webhookSecret,body,header(request,'x-hub-signature-256'))){answer(401,'rejected','invalid signature');return;}
    if(event==='ping'){answer(200,'pong',null);return;}
    if(event!=='issues'){answer(202,'ignored',`event ${event} does not start a coordinator`);return;}
    let payload:unknown;
    try {payload=JSON.parse(body.toString('utf8'));} catch {answer(400,'rejected','payload is not JSON');return;}
    const settings=await options.settings();
    if(!settings.ok){answer(500,'unavailable',settings.error);return;}
    const decision=await decideIssuesEvent(payload,settings.value);
    if(decision.kind==='ignored'){answer(202,'ignored',decision.reason);return;}
    const {target}=decision;
    answer(202,'launching',target.reference,{frontend:target.frontend.kind});
    const outcome=await launchFrontend(target.frontend,target,runner);
    options.log({at:new Date().toISOString(),source:'webhook',delivery,event,reference:target.reference,outcome:outcome.kind,
      detail:outcome.kind==='existing'?outcome.detail:outcome.kind==='frontendFailed'?outcome.output:null});
  };
  const server=createServer((request,response)=>{
    handle(request,response).catch((error:unknown)=>{
      const message=error instanceof Error?error.message:String(error);
      options.log({at:new Date().toISOString(),source:'webhook',outcome:'failed',detail:message});
      if(!response.headersSent){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({outcome:'failed',detail:message}));}
    });
  });
  const listening=Promise.withResolvers<void>();
  server.once('error',listening.reject);
  server.listen(options.port,options.host,()=>{server.off('error',listening.reject);listening.resolve();});
  await listening.promise;
  const port=(server.address() as AddressInfo).port;
  options.log({at:new Date().toISOString(),source:'webhook',outcome:'listening',host:options.host,port});
  return {host:options.host,port,close:()=>{
    const closed=Promise.withResolvers<void>();
    server.close(error=>error?closed.reject(error):closed.resolve());
    return closed.promise;
  }};
}
