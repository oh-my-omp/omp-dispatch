// A closed-vocabulary GraphQL evaluator for the simulated GitHub. It parses the
// selection sets src/ports/github.ts sends and resolves them against typed
// nodes. Any field, argument shape or fragment the node type does not declare
// fails the whole request, so a port query that drifts from this model fails
// loudly instead of being answered with invented data.

export type Args = Record<string, unknown>;
export type Value = null | string | number | boolean | Node | Value[];
/** A GraphQL object: its concrete type name and the fields it can resolve. */
export type Node = {typename: string; fields: Record<string, (args: Args) => Value>};
type Selection =
  | {kind: 'field'; alias: string; name: string; args: Args; selections: Selection[] | null}
  | {kind: 'fragment'; on: string; selections: Selection[]};

export class QueryError extends Error {}

type Token = {kind: 'name' | 'string' | 'number' | 'punct'; text: string};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/[\s,]/.test(char)) { index++; continue; }
    if (source.startsWith('...', index)) { tokens.push({kind: 'punct', text: '...'}); index += 3; continue; }
    if ('{}():[]'.includes(char)) { tokens.push({kind: 'punct', text: char}); index++; continue; }
    if (char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      tokens.push({kind: 'string', text: JSON.parse(source.slice(index, end + 1)) as string});
      index = end + 1; continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (name) { tokens.push({kind: 'name', text: name[0]}); index += name[0].length; continue; }
    const number = /^-?\d+/.exec(source.slice(index));
    if (number) { tokens.push({kind: 'number', text: number[0]}); index += number[0].length; continue; }
    throw new QueryError(`Unexpected character ${JSON.stringify(char)} at ${index}`);
  }
  return tokens;
}

/** Parses `query { ... }` or `mutation { ... }` into its operation and root selection set. */
export function parseQuery(source: string): {operation: 'query' | 'mutation'; selections: Selection[]} {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (expected?: string): Token => {
    const token = tokens[position++];
    if (!token || expected !== undefined && token.text !== expected) throw new QueryError(`Expected ${expected ?? 'a token'}, found ${token?.text ?? 'end of query'}`);
    return token;
  };
  function value(): unknown {
    const token = take();
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.text === '[') {
      const items: unknown[] = [];
      while (peek()?.text !== ']') items.push(value());
      take(']'); return items;
    }
    if (token.text === '{') {
      const object: Args = {};
      while (peek()?.text !== '}') { const key = take().text; take(':'); object[key] = value(); }
      take('}'); return object;
    }
    if (token.kind === 'name') return token.text === 'true' ? true : token.text === 'false' ? false : token.text === 'null' ? null : {enum: token.text};
    throw new QueryError(`Unexpected argument token ${token.text}`);
  }
  function selections(): Selection[] {
    take('{');
    const result: Selection[] = [];
    while (peek()?.text !== '}') {
      if (peek()?.text === '...') {
        take('...'); take('on');
        result.push({kind: 'fragment', on: take().text, selections: selections()});
        continue;
      }
      let name = take().text, alias = name;
      if (peek()?.text === ':') { take(':'); alias = name; name = take().text; }
      const args: Args = {};
      if (peek()?.text === '(') {
        take('(');
        while (peek()?.text !== ')') { const key = take().text; take(':'); args[key] = value(); }
        take(')');
      }
      result.push({kind: 'field', alias, name, args, selections: peek()?.text === '{' ? selections() : null});
    }
    take('}');
    return result;
  }
  const operation = take().text;
  if (operation !== 'query' && operation !== 'mutation') throw new QueryError(`Unsupported operation ${operation}`);
  const root = selections();
  if (position !== tokens.length) throw new QueryError('Trailing tokens after the query');
  return {operation, selections: root};
}

function project(node: Node, selected: Selection[], path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selected) {
    if (selection.kind === 'fragment') {
      if (selection.on === node.typename) Object.assign(out, project(node, selection.selections, path));
      continue;
    }
    if (selection.name === '__typename') { out[selection.alias] = node.typename; continue; }
    const resolve = node.fields[selection.name];
    if (!resolve) throw new QueryError(`${node.typename} has no field ${selection.name} (at ${path})`);
    out[selection.alias] = shape(resolve(selection.args), selection.selections, `${path}.${selection.alias}`);
  }
  return out;
}

function shape(value: Value, selected: Selection[] | null, path: string): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item, index) => shape(item, selected, `${path}[${index}]`));
  if (typeof value === 'object') {
    if (!selected) throw new QueryError(`Object field ${path} needs a selection set`);
    return project(value, selected, path);
  }
  if (selected) throw new QueryError(`Scalar field ${path} cannot have a selection set`);
  return value;
}

/** Evaluates a query or mutation against its root node. Throws QueryError on anything outside the model. */
export function evaluate(source: string, roots: {query: Node; mutation: Node}): Record<string, unknown> {
  const parsed = parseQuery(source);
  return project(roots[parsed.operation], parsed.selections, parsed.operation);
}
