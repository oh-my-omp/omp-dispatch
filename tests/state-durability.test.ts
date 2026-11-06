import {describe,expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {Agenda} from '../src/domain/model.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {z} from '@oh-my-pi/omptype/zod';
import {YAML} from 'bun';
import {parseWorkflow} from '../src/domain/workflow.ts';

const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const workflow=parsedWorkflow.value;

function agenda():Agenda {
  return {id:'aaaabbbb-1111-4111-8111-111111111111',version:1,nextId:1,convenedAt:1,lifecycle:'active',parent:null,workflow,closure:null,effects:[],run:{kind:'detached'},summary:null,tickets:[{
    id:'one',revision:1,issue:{repo:{owner:'test',name:'repo'},number:1},target:{repo:{owner:'test',name:'repo'},base:'main'},dependsOn:[],contract:{revision:1,bodyHash:'0'.repeat(64),body:''},state:'Coding',sessions:{},visits:{Coding:1},started:false,pr:null,gates:{},rulings:[],notes:[],terminal:null,
  }]};
}

describe('durable ticket agenda files',()=>{
  test('exact retries retain their version; conflicting writes and old envelopes are rejected',async()=>{
    const root=await mkdtemp(join(tmpdir(),'dispatch-state-'));
    try {
      const files=createAgendaFiles(root),state=agenda();
      expect(await files.save(null,state)).toEqual({ok:true,value:null});
      expect(await files.save(null,state)).toEqual({ok:true,value:null});
      const loaded=await files.load(state.id);expect(loaded.ok).toBe(true);
      if(!loaded.ok)throw new Error(loaded.error.message);
      expect(loaded.value.version).toBe(1);
      const advanced=structuredClone(state);advanced.version=2;advanced.tickets[0]!.notes.push({at:2,author:{kind:'main'},kind:'ruling',text:'Advance only after a durable predecessor.'});
      expect(await files.save(9,advanced)).toMatchObject({ok:false,error:{kind:'versionConflict'}});
      expect(await files.save(1,advanced)).toEqual({ok:true,value:null});
      const path=join(root,'state',`${state.id}.json`);
      const encoded:unknown=JSON.parse(await readFile(path,'utf8'));
      expect(encoded).toMatchObject({format:8,state:{version:2}});
      await writeFile(path,JSON.stringify({format:7,state}));
      expect(await files.load(state.id)).toMatchObject({ok:false,error:{kind:'unsupportedFormat'}});
    }finally {await rm(root,{recursive:true,force:true});}
  });

  test('saving fsyncs the owned directory without opening ancestor directories',async()=>{
    const root=await mkdtemp(join(tmpdir(),'dispatch-fsync-'));
    try {
      const driver=join(root,'trace.ts'),source=resolve('src/ports/state.ts');
      await writeFile(driver,`import {syncBuiltinESMExports} from 'node:module';
const fs=require('node:fs/promises');
const original=fs.open;
const directories:string[]=[];
fs.open=async (...args:Parameters<typeof original>)=>{
  const handle=await original(...args);
  if((await handle.stat()).isDirectory())directories.push(String(args[0]));
  return handle;
};
syncBuiltinESMExports();
// Dynamic import is intentional: instrument the builtin module before loading the port.
const {createAgendaFiles}=await import(${JSON.stringify(source)});
const result=await createAgendaFiles(${JSON.stringify(root)}).save(null,${JSON.stringify(agenda())});
console.log(JSON.stringify({result,directories}));`);
      const child=Bun.spawn([process.execPath,driver],{stdout:'pipe',stderr:'pipe'});
      const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      if(errors)throw new Error(errors);
      const parsed=z.object({result:z.object({ok:z.literal(true),value:z.literal(null)}),directories:z.array(z.string())}).parse(JSON.parse(output));
      expect(new Set(parsed.directories)).toEqual(new Set([join(root,'state')]));
    }finally {await rm(root,{recursive:true,force:true});}
  });
});
