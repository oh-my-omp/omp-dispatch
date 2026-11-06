import {expect,test} from 'bun:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createProcessPort} from '../src/ports/process.ts';

test('the OS names this process by pid and a start time that a second read repeats',async()=>{
  const port=createProcessPort();
  const self=await port.current();
  if(!self.ok)throw new Error(self.error.message);
  expect(self.value.pid).toBe(process.pid);
  expect(await port.start(process.pid)).toEqual({ok:true,value:{kind:'running',startedAt:self.value.startedAt}});
});

test('a process that has exited is absent from the OS process table',async()=>{
  const child=spawn('true');
  const pid=child.pid;if(pid===undefined)throw new Error('Child did not start');
  await once(child,'exit');
  expect(await createProcessPort().start(pid)).toEqual({ok:true,value:{kind:'absent'}});
});
