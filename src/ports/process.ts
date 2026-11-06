import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {PortError,Result} from '../domain/model.ts';
import type {ProcessPort,ProcessStart} from './contracts.ts';

const runFile=promisify(execFile);

/**
 * Reads start times from `ps -o lstart=`, whose whole-second text names one process together with its pid.
 * The C locale and TZ=UTC0 make every reader on this host see the same text for the same process.
 */
export function createProcessPort():ProcessPort {
  const start=async(pid:number):Promise<Result<ProcessStart,PortError>>=>{
    try {
      const {stdout}=await runFile('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:10_000,env:{...process.env,LC_ALL:'C',TZ:'UTC0'}});
      const startedAt=stdout.trim().replace(/\s+/g,' ');
      if(!/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(startedAt))return {ok:false,error:{kind:'invalidResponse',message:`ps reported no readable start time for pid ${pid}: ${JSON.stringify(stdout)}`}};
      return {ok:true,value:{kind:'running',startedAt}};
    } catch(error) {
      // Node's execFile rejects with an ExecFileException; ps exits 1 with no rows when no process holds the pid.
      const failure=error as {code?:number|string;stdout?:string;stderr?:string;message?:string};
      if(failure.code===1&&!failure.stdout?.trim()&&!failure.stderr?.trim())return {ok:true,value:{kind:'absent'}};
      return {ok:false,error:{kind:'unavailable',message:`ps -p ${pid}: ${failure.stderr?.trim()||failure.message||'failed'}`}};
    }
  };
  return {
    start,
    async current() {
      const self=await start(process.pid);if(!self.ok)return self;
      if(self.value.kind==='absent')return {ok:false,error:{kind:'invalidResponse',message:`ps does not list this process (pid ${process.pid})`}};
      return {ok:true,value:{pid:process.pid,startedAt:self.value.startedAt}};
    },
  };
}
