import {expect,test} from 'bun:test';
import type {Agenda} from '../src/domain/model.ts';
import {RuntimeExit} from '../src/runtime/exit.ts';

function agenda(lifecycle:'active'|'completed',id='agenda-1'):Agenda {
  return {id,version:1,nextId:1,convenedAt:1,lifecycle,parent:null,workflow:{ticket:{states:{}},parent:{states:{}}},tickets:[],closure:null,effects:[],run:{kind:'detached'},summary:null} as unknown as Agenda;
}

test('a granted exit fires once at a completed agenda',()=>{
  const requests:number[]=[];
  const exit=new RuntimeExit();
  exit.grant(()=>requests.push(1));
  exit.commit(true,agenda('completed'));
  expect(requests).toEqual([1]);
  // The spent request keeps later duplicates as no-ops.
  exit.commit(true,agenda('completed'));
  expect(requests).toEqual([1]);
});

test('no exit before an honest finish',()=>{
  const requests:number[]=[];
  const exit=new RuntimeExit();
  exit.grant(()=>requests.push(1));
  // Unfinished states: open tickets, Asking, Escalated, and a rejected finish pass.
  exit.commit(false,agenda('completed'));
  exit.commit(true,agenda('active'));
  exit.commit(false,agenda('active'));
  expect(requests).toEqual([]);
});

test('a completed agenda never exits without the coordinator identity',()=>{
  const requests:number[]=[];
  const exit=new RuntimeExit();
  // No grant: an ordinary omp session or an unstarted runtime.
  exit.commit(true,agenda('completed'));
  expect(requests).toEqual([]);
  // Granting after the fact still cannot spend an already-ignored finish.
  exit.grant(()=>requests.push(1));
  exit.commit(true,agenda('completed'));
  expect(requests).toEqual([1]);
});

test('the request survives repeated grants of the same host call shape at most once',()=>{
  const requests:string[]=[];
  const exit=new RuntimeExit();
  exit.grant(()=>requests.push('first'));
  exit.grant(()=>requests.push('second'));
  exit.commit(true,agenda('completed','agenda-2'));
  expect(requests).toEqual(['first']);
});
