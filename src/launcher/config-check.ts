import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {z} from '@oh-my-pi/omptype/zod';
import type {Result} from '../domain/model.ts';
import {PM_FILES,type PmFileError,validatePmFiles} from '../pm/config.ts';

export const CONFIG_CHECK_PATH='/pm-config/check';
export type ConfigCheckOptions={host:string;port:number;log:(entry:Readonly<Record<string,unknown>>)=>void};
export type ConfigCheckListener={host:string;port:number;close:()=>Promise<void>};

const MAX_BODY=1024*1024;
const PM_FILE_NAMES=Object.values(PM_FILES).sort().join('\n');
const checkRequest=z.object({files:z.record(z.string(),z.string())}).strict();

async function readBody(request:IncomingMessage):Promise<Buffer|null> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of request){
    size+=chunk.length;
    if(size>MAX_BODY)return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The request body is `{"files": {"<path>": "<full text>"}}` with exactly the three PM files. Anything else is a
 * malformed request, answered `400`; a well-formed set is then judged by `validatePmFiles`.
 */
export function parseCheckRequest(text:string):Result<Readonly<Record<string,string>>,string> {
  let json:unknown;
  try {json=JSON.parse(text);} catch {return {ok:false,error:'body is not JSON'};}
  const parsed=checkRequest.safeParse(json);
  if(!parsed.success)return {ok:false,error:'body must be {"files": {"<path>": "<text>"}}'};
  const names=Object.keys(parsed.data.files).sort().join('\n');
  if(names!==PM_FILE_NAMES)return {ok:false,error:`files must be exactly ${Object.values(PM_FILES).join(', ')}`};
  return {ok:true,value:parsed.data.files};
}

const CORS={'access-control-allow-origin':'*'};

/**
 * Judges a candidate PM configuration in memory with the same schemas the coordinator applies at start, so an editor
 * can refuse a save without starting a coordinator. It reads and writes no PM file. It has its own listener: the link
 * port is local-only and the webhook port is exposed through a tunnel, and this one is reached from another origin (the web UI).
 */
export async function serveConfigCheck(options:ConfigCheckOptions):Promise<ConfigCheckListener> {
  const handle=async(request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    const path=new URL(request.url??'/','http://127.0.0.1').pathname;
    const answer=(status:number,body:Readonly<Record<string,unknown>>|null,outcome:string,detail:string|null,headers:Readonly<Record<string,string>>={}):void=>{
      options.log({at:new Date().toISOString(),source:'config-check',method:request.method??null,path,outcome,detail});
      response.writeHead(status,{...CORS,...(body===null?{}:{'content-type':'application/json'}),...headers});
      response.end(body===null?undefined:JSON.stringify(body));
    };
    if(request.method==='OPTIONS'){answer(204,null,'preflight',null,{'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'});return;}
    if(path!==CONFIG_CHECK_PATH){answer(404,{error:`no route ${path}`},'notFound',path);return;}
    if(request.method!=='POST'){answer(405,{error:`${request.method} is not allowed`},'methodNotAllowed',request.method??null,{allow:'POST'});return;}
    const body=await readBody(request);
    if(body===null){answer(413,{error:'body is too large'},'rejected','body is too large');return;}
    const files=parseCheckRequest(body.toString('utf8'));
    if(!files.ok){answer(400,{error:files.error},'rejected',files.error);return;}
    const checked=validatePmFiles(files.value);
    if(checked.ok){answer(200,{ok:true},'valid',null);return;}
    const errors:PmFileError[]=checked.error;
    answer(200,{ok:false,errors},'invalid',errors.map(item=>`${item.file}: ${item.key}: ${item.message}`).join('\n'));
  };
  const server=createServer((request,response)=>{
    handle(request,response).catch((error:unknown)=>{
      const message=error instanceof Error?error.message:String(error);
      options.log({at:new Date().toISOString(),source:'config-check',outcome:'failed',detail:message});
      if(!response.headersSent){response.writeHead(500,{...CORS,'content-type':'application/json'});response.end(JSON.stringify({error:message}));}
    });
  });
  const listening=Promise.withResolvers<void>();
  server.once('error',listening.reject);
  server.listen(options.port,options.host,()=>{server.off('error',listening.reject);listening.resolve();});
  await listening.promise;
  const port=(server.address() as AddressInfo).port;
  options.log({at:new Date().toISOString(),source:'config-check',outcome:'listening',host:options.host,port});
  return {host:options.host,port,close:()=>{
    const closed=Promise.withResolvers<void>();
    server.close(error=>error?closed.reject(error):closed.resolve());
    return closed.promise;
  }};
}
