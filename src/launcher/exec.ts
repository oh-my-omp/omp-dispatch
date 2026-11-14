import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {diagnosticText} from './diagnostics.ts';

const runFile=promisify(execFile);
const commandTimeoutMs=30_000;

export type RunResult={code:number;stdout:string;stderr:string};
/** `env` adds variables to this process's environment for the command. */
export type Runner=(command:string,args:readonly string[],options:{cwd?:string;env?:Readonly<Record<string,string>>})=>Promise<RunResult>;

/** One place runs a local command for the launcher; a fake substitutes it in tests. */
export const run:Runner=async(command,args,options)=>{
  try {
    const {stdout,stderr}=await runFile(command,[...args],{encoding:'utf8',maxBuffer:1024*1024,timeout:commandTimeoutMs,...(options.cwd===undefined?{}:{cwd:options.cwd}),...(options.env===undefined?{}:{env:{...process.env,...options.env}})});
    return {code:0,stdout,stderr};
  } catch(error) {
    // Node's execFile rejects with an ExecFileException whose payload the bun
    // type surface does not expose here; read the fields it does carry.
    const failure=error as {code?:number|string;killed?:boolean;stdout?:string;stderr?:string;message?:string};
    const message=failure.stderr?.trim()||(failure.killed===true?diagnosticText({kind:'timeout',command,seconds:commandTimeoutMs/1000}):'')||failure.message||diagnosticText({kind:'commandFailed'});
    return {code:typeof failure.code==='number'?failure.code:1,stdout:failure.stdout??'',stderr:message};
  }
};
