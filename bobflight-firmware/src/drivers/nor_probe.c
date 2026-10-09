/* SPDX-License-Identifier: Apache-2.0. Original implementation from the public
 * JEDEC/Winbond command descriptions. NO write-enable, erase, program or reset.
 * Each call advances at most one byte; no polling loops or control-task I/O. */
#include "drivers/nor_probe.h"
#include <string.h>
void nor_probe_cancel(nor_probe_t *p,const char *reason){
 if(!p)return;
 if(p->active){p->io.select(false,p->io.ctx);p->io.cancel(p->io.ctx);}
 p->active=false;p->reason=reason;
}
bool nor_probe_begin(nor_probe_t *p,const nor_probe_io_t *io,uint64_t now){
 if(!p||!io||!io->select||!io->start||!io->poll||!io->cancel||p->active)return false;
 memset(p,0,sizeof *p);p->io=*io;p->started=now;p->active=true;p->reason="probing";
 p->io.select(true,p->io.ctx);p->io.start(0x9f,p->io.ctx);return true;
}
void nor_probe_poll(nor_probe_t *p,uint64_t now){
 if(!p||!p->active)return;
 if(now<p->started||now-p->started>=100000u){nor_probe_cancel(p,"timeout");return;}
 if(p->step==4u){p->io.select(true,p->io.ctx);p->io.start(0x05,p->io.ctx);p->step=6u;return;}
 uint8_t byte=0;int state=p->io.poll(&byte,p->io.ctx);
 if(state<0){nor_probe_cancel(p,"spi-error");return;}
 if(!state)return;
 if(p->step>=1u&&p->step<=3u)p->id[p->step-1u]=byte;
 if(p->step==3u){
  p->io.select(false,p->io.ctx);p->step=4u;
  /* CS high across calls: guaranteed inter-command deselection. */
  return;
 }
 if(p->step==6u){p->step=5u;p->io.start(0xff,p->io.ctx);return;}
 if(p->step==5u){
  p->status=byte;p->known=p->id[0]==0xefu&&p->id[1]==0x40u&&(p->id[2]==0x18u||p->id[2]==0x19u);
  if(p->known)p->capacity=p->id[2]==0x18u?16777216u:33554432u;
  p->complete=true;nor_probe_cancel(p,(byte&1u)?"flash-busy":p->known?"identified":"unknown-jedec");return;
 }
 p->step++;p->io.start(0xff,p->io.ctx);
}
