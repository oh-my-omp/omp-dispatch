import {describe,expect,test} from 'bun:test';
import {YAML} from 'bun';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {encodeWorkflow,parseWorkflow,type Workflow} from '../src/domain/workflow.ts';
import {loadWorkflow} from '../src/ports/workflow.ts';

const source=await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text();
const parsed=parseWorkflow(YAML.parse(source));
if(!parsed.ok)throw new Error(parsed.error.reason);
const defaultWorkflow=parsed.value;
function invalid(change:(workflow:Workflow)=>void):void {
  const workflow=structuredClone(defaultWorkflow);change(workflow);
  expect(parseWorkflow(encodeWorkflow(workflow)).ok).toBe(false);
}

describe('workflow validation',()=>{
  test('parseWorkflow accepts the built-in state machines and encode/parse is an exact inverse',()=>{
    expect(defaultWorkflow.ticket.initial).toBe('Coding');
    expect(defaultWorkflow.ticket.adopted).toEqual({pullRequest:'AwaitingChecks',mergeCommit:'Verifying'});
    expect(parseWorkflow(encodeWorkflow(defaultWorkflow))).toEqual({ok:true,value:defaultWorkflow});
  });
  test('parseWorkflow rejects an unknown target',()=>invalid(workflow=>{
    const state=workflow.ticket.states.Coding!;if(state.kind==='work')state.on.submitted.otherwise='Missing';
  }));
  test('parseWorkflow rejects an unreachable state',()=>invalid(workflow=>{workflow.ticket.states.Orphan={kind:'final',guard:null};}));
  test('parseWorkflow rejects an entry guard fallback cycle',()=>invalid(workflow=>{
    workflow.ticket.states.Reviewing!.guard={when:{kind:'checks',is:'passing'},otherwise:'Verifying'};
    workflow.ticket.states.Verifying!.guard={when:{kind:'checks',is:'passing'},otherwise:'Reviewing'};
  }));
  test('parseWorkflow rejects a guarded initial state',()=>invalid(workflow=>{
    workflow.ticket.states.Coding!.guard={when:{kind:'checks',is:'passing'},otherwise:'Publishing'};
  }));
  test('parseWorkflow rejects a non-work initial state',()=>invalid(workflow=>{workflow.ticket.initial='Publishing';}));
  test('parseWorkflow rejects a duplicate judge role across machines',()=>invalid(workflow=>{
    const state=workflow.parent.states.Reviewing!;if(state.kind==='judge')state.judges[0]!.role='review';
  }));
  test('parseWorkflow rejects a judge role equal to a work role',()=>invalid(workflow=>{
    const state=workflow.parent.states.Reviewing!;if(state.kind==='judge')state.judges[0]!.role='owner';
  }));
  test('parseWorkflow rejects a work role with two agents',()=>invalid(workflow=>{
    const coding=workflow.ticket.states.Coding!;
    if(coding.kind!=='work')throw new Error('Expected Coding work state');
    workflow.ticket.states.Rework={...structuredClone(coding),agent:'different-agent'};
    coding.on.escalated.otherwise='Rework';
  }));
  test('parseWorkflow rejects merge requires naming a mergeCommit judge',()=>invalid(workflow=>{
    const state=workflow.ticket.states.Merging!;if(state.kind==='action'&&state.action.kind==='merge')state.action.requires=['Verifying'];
  }));
  test('parseWorkflow rejects parent conditions using checks',()=>invalid(workflow=>{
    workflow.parent.states.Reviewing!.guard={when:{kind:'checks',is:'passing'},otherwise:'Closing'};
  }));
  test('parseWorkflow rejects a missing outcome',()=>{
    expect(parseWorkflow(YAML.parse(source.replace('on: {submitted: Publishing, escalated: escalate}','on: {submitted: Publishing}'))).ok).toBe(false);
  });
  test('parseWorkflow rejects a branch fallback before the last branch',()=>{
    const text=source.replace('submitted: Publishing','submitted: [{to: Publishing}, {when: {checks: passing}, to: Coding}]');
    expect(parseWorkflow(YAML.parse(text)).ok).toBe(false);
  });
  for(const name of ['escalate','Escalated'])test(`parseWorkflow rejects reserved state name ${name}`,()=>invalid(workflow=>{workflow.ticket.states[name]={kind:'final',guard:null};}));
  test('parseWorkflow rejects unknown fields at workflow, machine, state and judge boundaries',()=>{
    for(const text of [source+'extra: true\n',source.replace('  initial: Coding','  extra: true\n  initial: Coding'),source.replace('      role: owner','      extra: true\n      role: owner'),source.replace('        - role: review','        - extra: true\n          role: review')])expect(parseWorkflow(YAML.parse(text)).ok).toBe(false);
  });
  test('parseWorkflow rejects empty work and judge agents',()=>{
    for(const name of ['dispatch-owner','dispatch-reviewer'])expect(parseWorkflow(YAML.parse(source.replace(name,'""'))).ok).toBe(false);
  });
  test('parseWorkflow accepts empty judge states in both machines',()=>{
    const workflow=structuredClone(defaultWorkflow);
    for(const state of [...Object.values(workflow.ticket.states),...Object.values(workflow.parent.states)])if(state.kind==='judge')state.judges=[];
    expect(parseWorkflow(encodeWorkflow(workflow))).toEqual({ok:true,value:workflow});
  });
});

describe('workflow file source selection',()=>{
  test('a missing dataDir workflow loads the built-in state machines',async()=>{
    const root=await mkdtemp('/tmp/dispatch-workflow-');
    try {expect(await loadWorkflow({kind:'dataDir',path:join(root,'workflow.yml')})).toEqual({ok:true,value:defaultWorkflow});}
    finally {await rm(root,{recursive:true,force:true});}
  });
  test('an existing dataDir workflow overrides the built-in workflow',async()=>{
    const root=await mkdtemp('/tmp/dispatch-workflow-');
    try {
      const path=join(root,'workflow.yml'),workflow=structuredClone(defaultWorkflow);
      const coding=workflow.ticket.states.Coding!;if(coding.kind!=='work')throw new Error('Expected work');
      coding.agent='implementer';coding.brief='Deliver the configured change.';
      await writeFile(path,YAML.stringify(encodeWorkflow(workflow)));
      expect(await loadWorkflow({kind:'dataDir',path})).toEqual({ok:true,value:workflow});
    }finally {await rm(root,{recursive:true,force:true});}
  });
  test('a missing configured workflow reports its path rather than falling back',async()=>{
    const root=await mkdtemp('/tmp/dispatch-workflow-');
    try {
      const path=join(root,'required.yml');
      expect(await loadWorkflow({kind:'configured',path})).toMatchObject({ok:false,error:{source:path,reason:expect.stringContaining('does not exist')}});
    }finally {await rm(root,{recursive:true,force:true});}
  });
  test('an EISDIR dataDir workflow errors instead of falling back',async()=>{
    const root=await mkdtemp('/tmp/dispatch-workflow-');
    try {
      const path=join(root,'workflow.yml');await mkdir(path);
      expect(await loadWorkflow({kind:'dataDir',path})).toMatchObject({ok:false,error:{source:path}});
    }finally {await rm(root,{recursive:true,force:true});}
  });
  for(const [name,text] of [['invalid YAML','ticket: [unterminated'],['invalid schema','ticket: {}\nparent: {}\n']] as const)test(`an existing dataDir workflow with ${name} errors instead of using defaults`,async()=>{
    const root=await mkdtemp('/tmp/dispatch-workflow-');
    try {
      const path=join(root,'workflow.yml');await writeFile(path,text);
      const result=await loadWorkflow({kind:'dataDir',path});
      expect(result.ok).toBe(false);if(result.ok)throw new Error('Invalid override silently loaded');
      expect(result.error.source).toBe(path);
      if(name==='invalid YAML')expect(result.error.reason).toContain('Invalid YAML');
    }finally {await rm(root,{recursive:true,force:true});}
  });
});
