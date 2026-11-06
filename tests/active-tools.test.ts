import {expect,test} from 'bun:test';
import type {ExtensionAPI} from '@oh-my-pi/pi-coding-agent';
import {applyActiveTools} from '../active-tools.ts';

type Tool={name:string;sourceInfo:{source:string}};

function stub(registry:Tool[]):{pi:ExtensionAPI;calls:string[][]} {
  const calls:string[][]=[];
  const pi={getAllTools:()=>registry,setActiveTools:async(names:string[])=>{calls.push(names)}} as unknown as ExtensionAPI;
  return {pi,calls};
}

const builtin=(name:string):Tool=>({name,sourceInfo:{source:'builtin'}});
const extension=(name:string):Tool=>({name,sourceInfo:{source:'extension'}});
const names=['zeta','dispatch','read','alpha','bash','beta'];

test('same tool set yields the same array when only extension registration order differs',async()=>{
  const forward=stub([builtin('read'),builtin('bash'),extension('dispatch'),extension('zeta'),extension('alpha')]);
  const reverse=stub([builtin('read'),builtin('bash'),extension('alpha'),extension('zeta'),extension('dispatch')]);
  await applyActiveTools(forward.pi,names);
  await applyActiveTools(reverse.pi,[...names].reverse());
  expect(forward.calls).toEqual([['read','bash','alpha','beta','dispatch','zeta']]);
  expect(reverse.calls).toEqual(forward.calls);
});

test('builtins keep registry order, others sort by code unit and dedupe',async()=>{
  const {pi,calls}=stub([builtin('write'),builtin('read')]);
  await applyActiveTools(pi,['read','Z','a','a','write','mcp__x']);
  expect(calls).toEqual([['write','read','Z','a','mcp__x']]);
});
