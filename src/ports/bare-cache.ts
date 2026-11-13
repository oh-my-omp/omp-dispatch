import {dlopen,FFIType,read} from 'bun:ffi';
import {execFile} from 'node:child_process';
import {access,mkdir,open,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import type {SeatWorkspace} from './contracts.ts';

const runFile=promisify(execFile);
export type Worktree={bare:string;path:string};
export async function git(args:readonly string[]):Promise<string>{const {stdout}=await runFile('git',[...args]);return stdout.trim();}

const LOCK_EX=2,LOCK_NB=4,EINTR=4,RETRY_MS=20;
type Flock={flock:(fd:number,operation:number)=>number;errno:()=>number;wouldBlock:number};
let kernel:Flock|null=null;
function flock():Flock {
  if(kernel)return kernel;
  if(process.platform==='darwin'){
    const {symbols}=dlopen('/usr/lib/libSystem.B.dylib',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},__error:{args:[],returns:FFIType.ptr}});
    kernel={flock:symbols.flock,errno:()=>read.i32(symbols.__error()!),wouldBlock:35};
  }else if(process.platform==='linux'){
    const {symbols}=dlopen('libc.so.6',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
    kernel={flock:symbols.flock,errno:()=>read.i32(symbols.__errno_location()!),wouldBlock:11};
  }else throw new Error(`Repository cache locking needs flock(2), which ${process.platform} does not provide`);
  return kernel;
}

/** A held lock; releasing it closes the handle that holds it. */
type Release=()=>Promise<void>;

async function lockPosix(path:string):Promise<Release> {
  const system=flock();
  const handle=await open(path,'a',0o600);
  try {
    // A blocking flock(2) would stall this whole process, every other seat included, until the holder finishes.
    while(system.flock(handle.fd,LOCK_EX|LOCK_NB)!==0){
      const errno=system.errno();
      if(errno!==system.wouldBlock&&errno!==EINTR)throw new Error(`Cannot lock ${path}: flock failed with errno ${errno}`);
      await sleep(RETRY_MS);
    }
  }catch(error){await handle.close();throw error;}
  return ()=>handle.close();
}

const GENERIC_READ_WRITE=0xC0000000,FILE_SHARE_ALL=7,OPEN_ALWAYS=4,FILE_ATTRIBUTE_NORMAL=0x80,INVALID_HANDLE=-1n;
const LOCKFILE_FAIL_IMMEDIATELY=1,LOCKFILE_EXCLUSIVE_LOCK=2,ERROR_LOCK_VIOLATION=33,OVERLAPPED_BYTES=32;
type Kernel32={
  createFile:(path:Uint8Array)=>bigint;
  lockFile:(handle:bigint,overlapped:Uint8Array)=>number;
  closeHandle:(handle:bigint)=>number;
  lastError:()=>number;
};
let kernel32:Kernel32|null=null;
function windowsKernel():Kernel32 {
  if(kernel32)return kernel32;
  const {symbols}=dlopen('kernel32.dll',{
    CreateFileW:{args:[FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr],returns:FFIType.i64},
    LockFileEx:{args:[FFIType.i64,FFIType.u32,FFIType.u32,FFIType.u32,FFIType.u32,FFIType.ptr],returns:FFIType.i32},
    CloseHandle:{args:[FFIType.i64],returns:FFIType.i32},
    GetLastError:{args:[],returns:FFIType.u32},
  });
  kernel32={
    createFile:(path)=>symbols.CreateFileW(path,GENERIC_READ_WRITE,FILE_SHARE_ALL,null,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,null),
    lockFile:(handle,overlapped)=>symbols.LockFileEx(handle,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,1,0,overlapped),
    closeHandle:(handle)=>symbols.CloseHandle(handle),
    lastError:()=>symbols.GetLastError(),
  };
  return kernel32;
}

/** Windows has no flock(2): LockFileEx locks the file's first byte, and the system drops it with the handle or the process. */
async function lockWindows(path:string):Promise<Release> {
  const system=windowsKernel();
  const handle=system.createFile(Buffer.from(`${path}\0`,'utf16le'));
  if(handle===INVALID_HANDLE)throw new Error(`Cannot lock ${path}: CreateFileW failed with error ${system.lastError()}`);
  const overlapped=new Uint8Array(OVERLAPPED_BYTES);
  try {
    // Waiting inside LockFileEx would stall this whole process, every other seat included, until the holder finishes.
    while(system.lockFile(handle,overlapped)===0){
      const error=system.lastError();
      if(error!==ERROR_LOCK_VIOLATION)throw new Error(`Cannot lock ${path}: LockFileEx failed with error ${error}`);
      await sleep(RETRY_MS);
    }
  }catch(error){system.closeHandle(handle);throw error;}
  return async()=>{system.closeHandle(handle);};
}

/**
 * Runs `work` while holding the exclusive lock on `<bare>.lock`: flock(2) on macOS and Linux, LockFileEx on Windows.
 * Every coordinator process sharing the data directory takes this lock, so all git operations on one bare cache run in
 * order across processes; different caches never wait on each other. The operating system releases the lock when its
 * handle closes or its process dies. The lock file sits beside the cache because a cache without HEAD is removed and
 * cloned anew as a whole.
 */
export async function lockBare<T>(bare:string,work:()=>Promise<T>):Promise<T> {
  const path=`${bare}.lock`;
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const release=process.platform==='win32'?await lockWindows(path):await lockPosix(path);
  try {return await work();}finally {await release();}
}

/**
 * A detached worktree at `path` of the repository's bare cache under `reposDir`, at exactly the commit the seat must
 * build on or judge. The cache is cloned once and fetched before every checkout; seats never clone from the network.
 */
export function checkout(reposDir:string,path:string,cwd:string,spec:Exclude<SeatWorkspace,{kind:'fork'}>):Promise<Worktree> {
  const repo=spec.kind==='base'?spec.target.repo:spec.repo;
  const bare=join(reposDir,`${repo.owner}__${repo.name}.git`.toLowerCase());
  return lockBare(bare,async()=>{
    if(!await access(join(bare,'HEAD')).then(()=>true,()=>false)){
      await rm(bare,{recursive:true,force:true});
      await runFile('gh',['repo','clone',`${repo.owner}/${repo.name}`,bare,'--','--bare','--quiet'],{cwd});
      // A bare clone has no remote-tracking refspec; worktrees then fetch and track origin like an ordinary clone.
      await git(['-C',bare,'config','remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*']);
    }
    await git(['-C',bare,'fetch','--prune','--quiet','origin']);
    let commit:string;
    if(spec.kind==='base')commit=await git(['-C',bare,'rev-parse','--verify',`refs/remotes/origin/${spec.target.base}^{commit}`]);
    else {
      // A fork PR head lives only under the base repository's pull ref, not its branches.
      if(spec.pull!==null)await git(['-C',bare,'fetch','--quiet','origin',`+refs/pull/${spec.pull}/head:refs/dispatch/pull/${spec.pull}`]);
      commit=spec.sha;
    }
    const tree={bare,path};
    await mkdir(dirname(tree.path),{recursive:true,mode:0o700});
    await git(['-C',bare,'worktree','add','--detach','--quiet',tree.path,`${commit}^{commit}`]);
    const head=await git(['-C',tree.path,'rev-parse','HEAD']);
    if(head!==commit){await git(['-C',bare,'worktree','remove','--force',tree.path]);throw new Error(`Seat worktree is at ${head}, not the required ${commit}`);}
    return tree;
  });
}
