import {dlopen,FFIType} from 'bun:ffi';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {PortError,Result} from '../domain/model.ts';
import type {ProcessPort,ProcessStart} from './contracts.ts';

const runFile=promisify(execFile);
type StartRead=(pid:number)=>Promise<Result<ProcessStart,PortError>>;

/** `ps -o lstart=` reports a whole-second text that names one process together with its pid. */
const startPosix:StartRead=async(pid)=>{
  try {
    // The C locale and TZ=UTC0 make every reader on this host see the same text for the same process.
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

const PROCESS_QUERY_LIMITED_INFORMATION=0x1000,SYNCHRONIZE=0x100000,WAIT_OBJECT_0=0,WAIT_TIMEOUT=0x102;
/** FILETIME ticks (100 ns) between 1601-01-01 and the Unix epoch. */
const EPOCH_TICKS=116444736000000000n,TICKS_PER_SECOND=10_000_000n;
type Kernel32={
  openProcess:(pid:number)=>bigint;
  /** WAIT_TIMEOUT while the process runs, WAIT_OBJECT_0 once it has exited. */
  wait:(handle:bigint)=>number;
  /** The creation FILETIME, or null when the call fails. */
  creationTicks:(handle:bigint)=>bigint|null;
  closeHandle:(handle:bigint)=>number;
};
let kernel32:Kernel32|null=null;
function windowsKernel():Kernel32 {
  if(kernel32)return kernel32;
  const {symbols}=dlopen('kernel32.dll',{
    OpenProcess:{args:[FFIType.u32,FFIType.i32,FFIType.u32],returns:FFIType.i64},
    WaitForSingleObject:{args:[FFIType.i64,FFIType.u32],returns:FFIType.u32},
    GetProcessTimes:{args:[FFIType.i64,FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.i32},
    CloseHandle:{args:[FFIType.i64],returns:FFIType.i32},
  });
  kernel32={
    openProcess:(pid)=>symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,0,pid),
    wait:(handle)=>symbols.WaitForSingleObject(handle,0),
    creationTicks:(handle)=>{
      const [creation,exit,kernel,user]=[new BigUint64Array(1),new BigUint64Array(1),new BigUint64Array(1),new BigUint64Array(1)];
      return symbols.GetProcessTimes(handle,creation,exit,kernel,user)===0?null:creation[0]!;
    },
    closeHandle:(handle)=>symbols.CloseHandle(handle),
  };
  return kernel32;
}

/** The creation time in UTC with its full 100 ns resolution, e.g. `2026-11-13T22:55:14.1234567Z`. */
function creationText(ticks:bigint):string {
  const unix=ticks-EPOCH_TICKS;
  const seconds=new Date(Number(unix/TICKS_PER_SECOND)*1000).toISOString().slice(0,19);
  return `${seconds}.${(unix%TICKS_PER_SECOND).toString().padStart(7,'0')}Z`;
}

/**
 * When OpenProcess refuses a pid, GetLastError cannot tell why: across bun:ffi calls it does not keep the value OpenProcess set.
 * `process.kill(pid, 0)` answers in one native call: ESRCH means no process holds the pid, anything else means one does.
 */
function unopened(pid:number):Result<ProcessStart,PortError> {
  try {
    process.kill(pid,0);
  } catch(error) {
    if(error instanceof Error&&'code' in error&&error.code==='ESRCH')return {ok:true,value:{kind:'absent'}};
  }
  return {ok:false,error:{kind:'unavailable',message:`OpenProcess refused pid ${pid}, which a process holds`}};
}

/** OpenProcess and GetProcessTimes read the creation time from the kernel; no program has to be on PATH. */
const startWindows:StartRead=async(pid)=>{
  const system=windowsKernel();
  const handle=system.openProcess(pid);
  if(handle===0n)return unopened(pid);
  try {
    // The kernel keeps an exited process's object while any handle to it stays open; it holds the pid but no process runs.
    const state=system.wait(handle);
    if(state===WAIT_OBJECT_0)return {ok:true,value:{kind:'absent'}};
    if(state!==WAIT_TIMEOUT)return {ok:false,error:{kind:'unavailable',message:`WaitForSingleObject on pid ${pid} returned ${state}`}};
    const ticks=system.creationTicks(handle);
    if(ticks===null)return {ok:false,error:{kind:'unavailable',message:`GetProcessTimes failed for pid ${pid}`}};
    return {ok:true,value:{kind:'running',startedAt:creationText(ticks)}};
  } finally {
    system.closeHandle(handle);
  }
};

/** Reads process start times; `startedAt` is compared only for equality, so each platform keeps the text its source reports. */
export function createProcessPort():ProcessPort {
  const start=process.platform==='win32'?startWindows:startPosix;
  return {
    start,
    async current() {
      const self=await start(process.pid);if(!self.ok)return self;
      if(self.value.kind==='absent')return {ok:false,error:{kind:'invalidResponse',message:`ps does not list this process (pid ${process.pid})`}};
      return {ok:true,value:{pid:process.pid,startedAt:self.value.startedAt}};
    },
  };
}
