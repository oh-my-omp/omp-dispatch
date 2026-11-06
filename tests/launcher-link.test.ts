import {describe, expect, test} from 'bun:test';
import {isUserNavigation,parseLinkPath,resolveTarget} from '../src/launcher/link.ts';
import {type RunResult,type Runner} from '../src/launcher/exec.ts';
import {connectedWindow,launch,liveCoordinatorBlock} from '../src/launcher/tern.ts';

// The launcher's whole behaviour is: read a link, decide, call Tern. These
// checks drive that decision with a fake Tern and a real filesystem stat.

type Call={command:string;args:readonly string[];cwd:string|undefined};

function fakeRunner(responses:Readonly<Record<string,RunResult|readonly RunResult[]>>):{calls:Call[];runner:Runner} {
  const calls:Call[]=[];
  const used=new Map<string,number>();
  return {calls,runner:async(command,args,options)=>{
    calls.push({command,args,cwd:options.cwd});
    const key=`${command} ${args.join(' ')}`;
    const response=responses[key];
    if(!response)throw new Error(`Unexpected command: ${key}`);
    const sequence=Array.isArray(response)?response:[response];
    const index=used.get(key)??0;used.set(key,index+1);
    return sequence[Math.min(index,sequence.length-1)] as RunResult;
  }};
}

const ok=(stdout:string):RunResult=>({code:0,stdout,stderr:''});
const failed=(stderr:string):RunResult=>({code:1,stdout:'',stderr});

const listing=(blocks:readonly {id:number;live:boolean;exited?:number|null;args:readonly string[]}[]):string=>JSON.stringify({sessions:[{id:1,tabs:[{id:2,blocks}]}]});
const inspection=(clients:readonly string[]):string=>JSON.stringify({clients:clients.map((kind,index)=>({conn:index+1,kind}))});
const reference='Acme/dispatch#7';
const liveBlock={id:42,live:true,args:['--dispatch',reference]};
const target={frontend:'tern' as const,issue:{repo:{owner:'Acme',name:'dispatch'},number:7},reference,cwd:'/tmp'};
const windowed={
  'tern inspect --json':ok(inspection(['cli','window'])),
};

describe('link contract',()=>{
  test('accepts one frontend, one owner/repo and one issue number',()=>{
    const parsed=parseLinkPath('/tern/Acme/dispatch/issues/7');
    expect(parsed.ok).toBe(true);
    if(parsed.ok)expect(parsed.value).toEqual({repo:{owner:'Acme',name:'dispatch'},number:7});
  });

  test('rejects every path that is not one tern issue link',()=>{
    for(const path of ['/wezterm/Acme/dispatch/issues/7','/tern/Acme/dispatch/pulls/7','/tern/Acme/dispatch/issues/abc','/tern/Acme/dispatch/issues/0','/tern/Acme/dispatch','/tern/Acme/dispatch/issues/7/extra']){
      const parsed=parseLinkPath(path);
      expect(parsed.ok).toBe(false);
      if(!parsed.ok)expect(parsed.error.kind).toBe('rejected');
    }
  });

  test('serves only a user click navigation',()=>{
    expect(isUserNavigation({mode:'navigate',user:'?1'})).toBe(true);
    expect(isUserNavigation({mode:'navigate',user:undefined})).toBe(false);
    expect(isUserNavigation({mode:'cors',user:'?1'})).toBe(false);
    expect(isUserNavigation({mode:undefined,user:undefined})).toBe(false);
  });

  test('requires an existing absolute cwd and decodes it from the query',async()=>{
    const accepted=await resolveTarget({pathname:'/tern/Acme/dispatch/issues/7',search:'?cwd=%2Ftmp'});
    expect(accepted.ok).toBe(true);
    if(accepted.ok){expect(accepted.value.cwd).toBe('/tmp');expect(accepted.value.reference).toBe(reference);}
    for(const search of ['', '?cwd=relative/path','?cwd=%2Fnonexistent-omp-dispatch-check','?cwd=%2Fetc%2Fhosts']){
      const refused=await resolveTarget({pathname:'/tern/Acme/dispatch/issues/7',search});
      expect(refused.ok).toBe(false);
      if(!refused.ok)expect(refused.error.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('coordinator discovery and launch decision',()=>{
  test('matches only a live, unexited block already running the exact reference',()=>{
    expect(liveCoordinatorBlock(listing([liveBlock]),reference)).toBe('42');
    expect(liveCoordinatorBlock(listing([{...liveBlock,live:false}]),reference)).toBeNull();
    expect(liveCoordinatorBlock(listing([{id:9,live:true,args:['--dispatch','Acme/dispatch#8']}]),reference)).toBeNull();
    expect(liveCoordinatorBlock(listing([{id:9,live:true,args:[`--dispatch=${reference}`]}]),reference)).toBe('9');
    // Tern reports a launched command as `<shell> -c "<command>"`, with the
    // whole command in one entry; the real launcher tab must still be found.
    expect(liveCoordinatorBlock(listing([{id:11,live:true,args:['-c',`omp --dispatch '${reference}'`]}]),reference)).toBe('11');
    expect(liveCoordinatorBlock(listing([{id:11,live:true,args:['-c',`omp --dispatch 'Acme/dispatch#8'`]}]),reference)).toBeNull();
    // Tern keeps a finished command's pane listed as live with its exit code.
    expect(liveCoordinatorBlock(listing([{id:12,live:true,exited:1,args:['-c',`omp --dispatch '${reference}'`]}]),reference)).toBeNull();
    expect(liveCoordinatorBlock('not json',reference)).toBeNull();
  });

  test('reads a connected window from the daemon report',()=>{
    expect(connectedWindow(inspection(['cli','window']))).toBe(true);
    expect(connectedWindow(inspection(['cli']))).toBe(false);
    expect(connectedWindow('')).toBe(false);
  });

  test('focuses the live coordinator instead of starting a second process',async()=>{
    const {calls,runner}=fakeRunner({
      ...windowed,
      'tern ls --json':ok(listing([liveBlock])),
      'tern focus 42':ok(''),
    });
    const outcome=await launch(target,runner);
    expect(outcome).toEqual({kind:'focused',block:'42'});
    expect(calls.map(call=>call.args.join(' '))).toEqual(['inspect --json','ls --json','focus 42']);
  });

  test('opens a coordinator tab in the link cwd when no live block matches',async()=>{
    const {calls,runner}=fakeRunner({
      ...windowed,
      'tern ls --json':ok(listing([])),
      'tern new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7':ok(''),
    });
    const outcome=await launch(target,runner);
    expect(outcome).toEqual({kind:'launched'});
    expect(calls.map(call=>call.args.join(' '))).toEqual(['inspect --json','ls --json','new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7']);
  });

  test('opens a window before launching when the daemon has none',async()=>{
    const {calls,runner}=fakeRunner({
      'tern inspect --json':ok(inspection(['cli'])),
      'tern ls --json':ok(listing([])),
      'tern /tmp':ok(''),
      'tern new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7':ok(''),
    });
    const outcome=await launch(target,runner);
    expect(outcome).toEqual({kind:'launched'});
    expect(calls.map(call=>call.args.join(' '))).toEqual(['inspect --json','ls --json','/tmp','new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7']);
  });

  test('opens the window, then focuses the surviving coordinator rather than a second one',async()=>{
    const {calls,runner}=fakeRunner({
      'tern inspect --json':ok(inspection(['cli'])),
      'tern ls --json':ok(listing([liveBlock])),
      'tern /tmp':ok(''),
      'tern focus 42':ok(''),
    });
    const outcome=await launch(target,runner);
    expect(outcome).toEqual({kind:'focused',block:'42'});
    expect(calls.map(call=>call.args.join(' '))).toEqual(['inspect --json','ls --json','/tmp','focus 42']);
  });

  test('starts Tern itself when no daemon answers',async()=>{
    const {calls,runner}=fakeRunner({
      'tern inspect --json':failed('no session daemon'),
      'tern ls --json':[failed('no session daemon'),ok(listing([]))],
      'tern /tmp':ok(''),
      'tern new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7':ok(''),
    });
    const outcome=await launch(target,runner);
    expect(outcome).toEqual({kind:'launched'});
    expect(calls.filter(call=>call.args.join(' ')==='ls --json').length).toBe(2);
  });

  test('reports the frontend output when Tern cannot start anything',async()=>{
    const {runner}=fakeRunner({
      ...windowed,
      'tern ls --json':ok(listing([])),
      'tern new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7':failed('tern: no session to add a tab to'),
    });
    const outcome=await launch(target,runner);
    expect(outcome.kind).toBe('frontendFailed');
    if(outcome.kind==='frontendFailed')expect(outcome.output).toContain('tern: no session to add a tab to');
  });

  test('reports a window that cannot be opened at all',async()=>{
    const {runner}=fakeRunner({
      'tern inspect --json':ok(inspection(['cli'])),
      'tern ls --json':failed('no session daemon'),
      'tern /tmp':failed('tern: cannot start the window'),
    });
    const outcome=await launch(target,runner);
    expect(outcome.kind).toBe('frontendFailed');
    if(outcome.kind==='frontendFailed')expect(outcome.output).toContain('tern: cannot start the window');
  });
});
