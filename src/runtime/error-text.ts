import {tr} from '../i18n.ts';
import type {RuntimeError} from './controller.ts';

/** Detailed protocol diagnostics remain in the log; notifications render their structured category. */
export function runtimeErrorText(error:RuntimeError):string {
  const detail=tr('See the Dispatch runtime error in the log for diagnostic details.','诊断详情请查看日志中的调度运行错误。');
  switch(error.kind){
    case 'domain':return tr(`Dispatch: ticket operation failed (${error.error.kind}). ${detail}`,`调度：工单操作失败（${error.error.kind}）。${detail}`);
    case 'storage':return tr(`Dispatch: durable state failed (${error.error.kind}). ${detail}`,`调度：持久状态操作失败（${error.error.kind}）。${detail}`);
    case 'source':return tr(`Dispatch: source request failed (${error.error.kind}). ${detail}`,`调度：源头请求失败（${error.error.kind}）。${detail}`);
    case 'host':return tr(`Dispatch: seat host failed (${error.error.kind}). ${detail}`,`调度：席位宿主操作失败（${error.error.kind}）。${detail}`);
    case 'workflow':return tr(`Dispatch: workflow could not be loaded (${error.error.source}). ${detail}`,`调度：无法加载工作流（${error.error.source}）。${detail}`);
  }
}
