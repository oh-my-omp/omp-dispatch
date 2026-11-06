import type {ExtensionAPI} from '@oh-my-pi/pi-coding-agent';

/**
 * Activates `names` in an order that depends only on the set of names: builtin tools first in `getAllTools()` order,
 * then every other requested name in code-unit order. Registration timing cannot change the array the host receives.
 */
export async function applyActiveTools(pi:ExtensionAPI,names:Iterable<string>):Promise<void> {
  const requested=new Set(names);
  const builtin=[...new Set(pi.getAllTools().filter(tool=>tool.sourceInfo.source==='builtin'&&requested.has(tool.name)).map(tool=>tool.name))];
  const taken=new Set(builtin);
  const others=[...requested].filter(name=>!taken.has(name)).sort((a,b)=>a<b?-1:a>b?1:0);
  await pi.setActiveTools([...builtin,...others]);
}
