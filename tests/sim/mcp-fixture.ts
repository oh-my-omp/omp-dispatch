// A stdio MCP server for the mcp-scope scenario, named `fx` in the run's `.omp/mcp.json`. It serves `load`;
// a `load` call makes it serve `added` as well. The server announces the change with
// `notifications/tools/list_changed` while the call is still in flight and answers the call only after omp
// has listed the tools again, so omp records `added` as a tool the calling session's MCP call added and
// grants it to that session's scope alone. `FX_LOADED` names a file the first `load` call creates, which a
// scripted seat waits for. Run by omp: `bun tests/sim/mcp-fixture.ts`.

import {writeFileSync} from 'node:fs';
import {z} from '@oh-my-pi/omptype/zod';

const requestSchema = z.object({jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]).optional(), method: z.string(),
  params: z.object({name: z.string().optional()}).passthrough().optional()});
type Id = number | string;

const LOAD = {name: 'load', description: 'Load the added tool.', inputSchema: {type: 'object', properties: {}}};
const ADDED = {name: 'added', description: 'A tool the load call added.', inputSchema: {type: 'object', properties: {}}};
let added = false;
/** The `load` call answered once omp has listed the tools that call added. */
let pendingLoad: Id | null = null;

const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', ...message})}\n`);

function answerLoad(): void {
  if (pendingLoad === null) return;
  const id = pendingLoad;
  pendingLoad = null;
  send({id, result: {content: [{type: 'text', text: 'fx loaded the added tool'}], isError: false}});
}

function handle(line: string): void {
  const parsed = requestSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return;
  const {id, method, params} = parsed.data;
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      send({id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {listChanged: true}}, serverInfo: {name: 'fx', version: '1.0.0'}}});
      return;
    case 'ping':
      send({id, result: {}});
      return;
    case 'tools/list':
      send({id, result: {tools: added ? [LOAD, ADDED] : [LOAD]}});
      answerLoad();
      return;
    case 'tools/call':
      if (params?.name === 'load') {
        if (!added && process.env.FX_LOADED) writeFileSync(process.env.FX_LOADED, '');
        added = true;
        pendingLoad = id;
        send({method: 'notifications/tools/list_changed'});
        // omp lists the tools again on the notice; answer anyway if it never does, so the call cannot hang.
        setTimeout(answerLoad, 5000);
      } else if (params?.name === 'added' && added) send({id, result: {content: [{type: 'text', text: 'fx added ran'}], isError: false}});
      else send({id, error: {code: -32602, message: `Unknown tool: ${params?.name}`}});
      return;
    default:
      send({id, error: {code: -32601, message: `Method not found: ${method}`}});
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
  }
});
