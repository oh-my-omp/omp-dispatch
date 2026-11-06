import {describe, expect, test} from 'bun:test';
import {Settings} from '@oh-my-pi/pi-coding-agent/config/settings';
import {lookup} from '@oh-my-pi/pi-coding-agent/config/registry';
import dispatch from '../index.ts';


const stubApi = {registerFlag() {}, registerTool() {}, registerCommand() {}, on() {}} as never;

describe('dispatch settings after extension load', () => {

	test('invalid values are still rejected', async () => {
		dispatch(stubApi);
		const settings = await Settings.init({inMemory: true, cwd: '/tmp'});
		expect(() => lookup('dispatch.recomputeIntervalSeconds')!.override(settings, 0 as never)).toThrow();
		expect(() => lookup('dispatch.dataDir')!.override(settings, '   ' as never)).toThrow();
		expect(lookup('dispatch.workflowFile')).toBeUndefined();
	});
});
