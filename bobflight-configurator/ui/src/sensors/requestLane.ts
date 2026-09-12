/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** At most one local read/action. Actions may wait for ONE current read, but
 * never survive a visibility/connection generation change; reads never queue. */
export class SensorRequestLane {
  generation=0;
  private active:Promise<unknown>|null=null;
  private actionPending=false;
  get hasPendingAction(){return this.actionPending;}
  invalidate(){this.generation++;}
  async read<T>(work:()=>Promise<T>):Promise<T|null>{
    if(this.active || this.actionPending)return null;
    const generation=this.generation;
    const p=Promise.resolve().then(()=>generation===this.generation?work():null);this.active=p;
    try{const value=await p;return generation===this.generation?value:null;}
    finally{if(this.active===p)this.active=null;}
  }
  async action<T>(work:()=>Promise<T>):Promise<T>{
    if(this.actionPending)throw new Error("Another calibration action is pending");
    const generation=this.generation;this.actionPending=true;
    try{
      if(this.active)await this.active.catch(()=>{});
      if(generation!==this.generation)throw new Error("Sensor session changed; action cancelled");
      const p=Promise.resolve().then(()=>{
        if(generation!==this.generation)throw new Error("Sensor session changed; action cancelled");
        return work();
      });this.active=p;
      try{const result=await p;if(generation!==this.generation)throw new Error("Sensor session changed; reply discarded");return result;}
      finally{if(this.active===p)this.active=null;}
    }finally{this.actionPending=false;}
  }
}
