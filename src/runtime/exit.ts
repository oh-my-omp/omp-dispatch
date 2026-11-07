import {logger} from '@oh-my-pi/pi-coding-agent';
import type {Agenda} from '../domain/model.ts';

/**
 * Exit decision for a `--dispatch` coordinator: its process is the inner layer of the pane the launcher
 * opened, so after the agenda finishes the process ends through the host's own exit and Tern reclaims the
 * pane. Only a coordinator identity grants the exit request, so ordinary omp sessions cannot exit here; the
 * request fires at most once, on a controller change after which the agenda honestly rests completed.
 */
export class RuntimeExit {
  private granted:null|(()=>void)=null;
  private requested=false;
  /**
   * Arms the exit with the host's graceful shutdown request (`ExtensionContext.shutdown()`, the same call the
   * host's `/exit` command makes). Granting twice keeps the first request; the host ignores a later one.
   */
  grant(request:()=>void):void {this.granted??=request;}
  /**
   * One checkpoint after a controller change: only a coordinator identity reaches here. `finished` is true
   * when the change ended an accepted `finish` op, or when the relay's or the run's own observer saw the
   * agenda completed; the agenda itself must rest completed, so a rejected or failed finish never exits.
   */
  commit(finished:boolean,agenda:Agenda|null):void {
    if(this.requested||!finished)return;
    if(!this.granted)return;
    if(!agenda||agenda.lifecycle!=='completed')return;
    this.requested=true;
    logger.info('Dispatch agenda is completed; the coordinator exits with it',{agendaId:agenda.id});
    this.granted();
  }
}
