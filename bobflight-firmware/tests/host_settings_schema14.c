/* SPDX-License-Identifier: Apache-2.0
 * N3 settings schema 14 against the REAL config_store.c + persist.c over an
 * in-memory two-slot flash (host_sim geometry):
 *  - 13->14 migration from a byte-exact schema 13 record written by schema 13
 *    firmware (tests/fixtures/settings_v13_record.h): every value kept, bytes
 *    0..255 identical, v13 record untouched until the first schema 14 save;
 *  - round-trip, write cuts during the migrating save, CRC/seal/length/board/
 *    schema corruption, layout_bytes (newer/short/nonzero reserved);
 *  - one defaults source: fresh boot == config_get_default_key == config_defaults()
 *    == `defaults <group>` == export diff baseline; mode ranges likewise.
 * Evidence is this host process; it is not bobflight_host and not hardware flash.
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "persist_host_stubs.h"
#include "fixtures/settings_v13_record.h"
#include "bobflight/version.h"
#include "../src/drivers/config_store.c"
#include "../src/drivers/persist.c"
static char out[4096];
static void cli_write_str(const char *s){assert(strlen(out)+strlen(s)<sizeof out);strcat(out,s);}
const char *control_mode_name(void){return manual_mode==CONTROL_MODE_ACRO?"acro":manual_mode==CONTROL_MODE_HORIZON?"horizon":"angle";}
#include "../src/drivers/defaults_cli.h"
#include "../src/drivers/storage_cli.h"

static int failures;
#define CHECK(c,...) do{if(!(c)){fprintf(stderr,"FAIL %s:%d: ",__FILE__,__LINE__);fprintf(stderr,__VA_ARGS__);fputc('\n',stderr);failures++;}}while(0)
#define SLOT1 262144u

typedef struct{bf_config_t cfg;motor_direction_t dir;uint32_t loop;const char*map;unsigned uart;control_mode_t mode;
 mode_config_t modes[MODE_COUNT];power_config_t power;unsigned speed;gyro_calibration_info_t cal;
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 bool aux;
#endif
}aircraft_t;
static void snap(aircraft_t *a){memset(a,0,sizeof *a);a->cfg=*config_get();a->dir=config_motor_direction();a->loop=loop_rate_setting_get();a->map=crsf_map();a->uart=board.rx_uart;a->mode=manual_mode;
 for(unsigned i=0;i<MODE_COUNT;i++){a->modes[i]=*mode_range_get((mode_id_t)i);}
 a->power=*power_config();a->speed=speed;a->cal=cal;
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 a->aux=aux_source;
#endif
}
static bool same_aircraft(const aircraft_t *a,const aircraft_t *b){
 return !memcmp(&a->cfg,&b->cfg,sizeof a->cfg)&&a->dir==b->dir&&a->loop==b->loop&&!strcmp(a->map,b->map)&&a->uart==b->uart&&a->mode==b->mode&&
  !memcmp(a->modes,b->modes,sizeof a->modes)&&!memcmp(&a->power,&b->power,sizeof a->power)&&a->speed==b->speed&&
  a->cal.accel_valid==b->cal.accel_valid&&!memcmp(a->cal.accel_bias,b->cal.accel_bias,12)&&!memcmp(a->cal.accel_scale,b->cal.accel_scale,12)
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
  &&a->aux==b->aux
#endif
  ;
}
/* Back to a cold boot: RAM defaults everywhere, stubs reset, flash kept. */
static void reboot(void){
 memset(&cal,0,sizeof cal);for(unsigned i=0;i<3;i++)cal.accel_scale[i]=1.f;
 manual_mode=CONTROL_MODE_ANGLE;board.rx_uart=6;speed=300;
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 aux_source=false;
#endif
 power_init();persist_init();
}
static void put_record(uint32_t off,uint32_t schema,uint32_t board_id,uint32_t gen,const uint8_t *payload,uint32_t n,bool seal){
 uint8_t *r=flash+off;memset(r,255,HEADER+n+COMMIT_BYTES);wr(r,MAGIC);wr(r+4,schema);wr(r+8,board_id);wr(r+12,n);wr(r+16,gen);wr(r+24,0);
 memcpy(r+HEADER,payload,n);wr(r+20,crc(r,n));if(seal)wr(r+HEADER+n,SEAL);
}
static void load_fixture(void){memset(flash,255,sizeof flash);memcpy(flash,settings_v13_record,SETTINGS_V13_RECORD_BYTES);}
static const uint8_t *v13_payload(void){return settings_v13_record+HEADER;}

static void test_defaults_single_source(void){
 /* Fresh boot = the static initializer, before any init call has run. */
 bf_config_t boot=*config_get();
 for(size_t i=0;i<config_key_count();i++){const char*k=config_key_name(i);float d=-1,v=-2;
  CHECK(config_get_default_key(k,&d)&&config_get_key(k,&v)&&d==v,"%s: default %g vs fresh boot %g",k,(double)d,(double)v);}
 float x;CHECK(!config_get_default_key("rate_type",&x)&&!config_get_default_key(NULL,&x),"unknown key has no default");
 for(unsigned i=0;i<MODE_COUNT;i++){mode_range_init();const mode_config_t*m=mode_range_get((mode_id_t)i),*d=mode_range_default((mode_id_t)i);
  CHECK(d&&m->enabled==d->enabled&&m->aux_channel==d->aux_channel&&m->min_us==d->min_us&&m->max_us==d->max_us,"mode %u default row",i);}
 CHECK(!mode_range_default(MODE_COUNT),"mode default bound");
 /* config_defaults() after a full scramble == fresh boot (byte for byte). */
 CHECK(configure_reference_aircraft(),"reference aircraft");
 CHECK(memcmp(config_get(),&boot,sizeof boot)!=0,"scramble changed config");
 config_defaults();CHECK(!memcmp(config_get(),&boot,sizeof boot)&&config_motor_direction()==MOTOR_DIRECTION_PROPS_OUT,"config_defaults == fresh boot");
 /* CLI `defaults <group>` == fresh boot for that group's keys; other keys untouched. */
 static const char *const groups[]={"pid","rates","filters"};
 for(unsigned g=0;g<3;g++){
  reboot();CHECK(configure_reference_aircraft(),"reference aircraft");
  bf_config_t before=*config_get();char line[32];snprintf(line,sizeof line,"defaults %s",groups[g]);
  out[0]=0;CHECK(cmd_defaults(line)&&strstr(out,"defaults_end: "),"%s reply: %s",line,out);
  size_t n;const char *const*keys=config_defaults_group_keys(groups[g],&n);
  for(size_t i=0;i<config_key_count();i++){const char*k=config_key_name(i);bool in=false;for(size_t j=0;j<n;j++)if(!strcmp(keys[j],k))in=true;
   float now,want;config_get_key(k,&now);
   if(in){config_get_default_key(k,&want);CHECK(now==want,"%s: %s=%g, fresh boot %g",line,k,(double)now,(double)want);}
   else{bf_config_t cur=*config_get();config_load_blob(&before);float was;config_get_key(k,&was);config_load_blob(&cur);CHECK(now==was,"%s moved %s",line,k);}
  }
 }
 /* Export diff on fresh defaults lists no set/mode_range lines: same source. */
 reboot();out[0]=0;cmd_config_export(false);
 CHECK(strstr(out,"# schema: 14\r\n")&&!strstr(out,"\r\nset ")&&!strstr(out,"\r\nmode_range "),"fresh diff not empty:\n%s",out);
 /* Every exported key has a default and is a config key (no second table). */
 CHECK(sizeof(g_export_keys)/sizeof(g_export_keys[0])==config_key_count(),"export key count %zu vs %zu",sizeof(g_export_keys)/sizeof(g_export_keys[0]),config_key_count());
 for(size_t i=0;i<config_key_count();i++){bool found=false;for(size_t j=0;j<config_key_count();j++)if(!strcmp(g_export_keys[j],config_key_name(i)))found=true;CHECK(found,"%s not exported",config_key_name(i));}
}

static void test_migration(void){
 aircraft_t want,got;reboot();CHECK(configure_reference_aircraft(),"reference aircraft");snap(&want);
 load_fixture();reboot();
 CHECK(persist_load(),"v13 load: %s",persist_last_error());snap(&got);config_board_alignment_activate();
 CHECK(same_aircraft(&want,&got),"migrated values differ from the schema 13 aircraft");
 CHECK(!strcmp(persist_stored_schema(),"13")&&config_store_loaded_schema()==13&&persist_generation()==1,"stored_schema 13, generation 1");
 CHECK(!memcmp(saved,v13_payload(),256),"bytes 0..255 not byte-exact after migration");
 CHECK(get32(saved+256)==LAYOUT_BYTES,"layout_bytes %u",(unsigned)get32(saved+256));
 for(unsigned i=LAYOUT_BYTES;i<PAYLOAD_BYTES;i++)if(saved[i]){CHECK(0,"reserved byte %u nonzero",i);break;}
 CHECK(!persist_dirty()&&!strcmp(persist_state(),"saved")&&!strcmp(persist_accel_storage(),"host-sim"),"migrated state %s/%s",persist_state(),persist_accel_storage());
 CHECK(!memcmp(flash,settings_v13_record,SETTINGS_V13_RECORD_BYTES),"load wrote flash");
 for(unsigned i=0;i<RECORD_BYTES;i++)if(flash[SLOT1+i]!=255){CHECK(0,"load touched slot 1");break;}
 out[0]=0;cmd_storage();CHECK(strstr(out,"\r\nschema: 14\r\n")&&strstr(out,"\r\nstate: saved\r\n")&&strstr(out,"\r\nstored_schema: 13\r\nstorage_end: 1\r\n"),"storage:\n%s",out);
 /* Save (the real CLI `save`) writes schema 14 to the OTHER slot; the v13 record stays byte-exact. */
 out[0]=0;cmd_save_config();CHECK(!strcmp(out,"saved: host_sim verified\r\n"),"migrating save: %s / %s",out,persist_last_error());
 CHECK(!memcmp(flash,settings_v13_record,SETTINGS_V13_RECORD_BYTES),"first v14 save touched the v13 record");
 CHECK(rd(flash+SLOT1+4)==14&&rd(flash+SLOT1+12)==1024&&rd(flash+SLOT1+16)==2&&!memcmp(flash+SLOT1+HEADER,v13_payload(),256)&&get32(flash+SLOT1+HEADER+256)==LAYOUT_BYTES,"v14 record header/payload");
 CHECK(!strcmp(persist_stored_schema(),"14")&&persist_generation()==2,"after save stored_schema %s gen %u",persist_stored_schema(),(unsigned)persist_generation());
 /* Round trip: reboot reads the v14 record, identical aircraft, not dirty. */
 reboot();CHECK(persist_load(),"v14 load: %s",persist_last_error());config_board_alignment_activate();snap(&got);
 CHECK(same_aircraft(&want,&got)&&!persist_dirty()&&!strcmp(persist_stored_schema(),"14"),"v14 round trip");
 /* Unchanged save does not wear flash; a changed save replaces the v13 slot. */
 unsigned e=flash_erases;CHECK(persist_save()&&flash_erases==e,"no-wear save");
 CHECK(config_set_key("rate_max_roll",671),"set");CHECK(persist_save()&&rd(flash+4)==14&&rd(flash+16)==3,"second save replaces v13 slot");
 reboot();CHECK(persist_load()&&config_get()->rate_max_roll==671,"reload after second save");
}

static void test_migration_power_cut(void){
 /* Cut the migrating save at every byte: the v13 record always survives and
  * loads (or the complete v14 record does); nothing is ever half-applied. */
 aircraft_t want,got;reboot();CHECK(configure_reference_aircraft(),"ref");snap(&want);
 unsigned bad=0;
 for(int cut=0;cut<=(int)RECORD_BYTES;cut+=7){
  load_fixture();reboot();if(!persist_load()){bad++;continue;}config_board_alignment_activate();
  flash_write_budget=cut;bool ok=persist_save();flash_write_budget=-1;
  if(memcmp(flash,settings_v13_record,SETTINGS_V13_RECORD_BYTES))bad++;
  reboot();if(!persist_load()){bad++;continue;}config_board_alignment_activate();snap(&got);
  if(!same_aircraft(&want,&got))bad++;
  if(ok&&strcmp(persist_stored_schema(),"14"))bad++;
  if(!ok&&strcmp(persist_stored_schema(),"13")&&strcmp(persist_stored_schema(),"14"))bad++;
 }
 CHECK(!bad,"%u power-cut cases lost or changed settings",bad);
}

static void test_corruption(void){
 const uint32_t tag=rd(settings_v13_record+8);
 /* v13 payload bit flip -> CRC fails -> invalid_record, defaults kept, no write. */
 for(unsigned at=HEADER;at<HEADER+256;at+=37){
  load_fixture();flash[at]^=0x10;reboot();unsigned e=flash_erases;
  CHECK(!persist_load()&&!strcmp(persist_last_error(),"invalid_record")&&!strcmp(persist_state(),"error")&&config_get()->rate_max_roll==800.f,"v13 CRC flip at %u: %s",at,persist_last_error());
  CHECK(!persist_save()&&flash_erases==e,"save over a corrupt-only store must refuse");
 }
 load_fixture();flash[HEADER+256]^=1;reboot();CHECK(!persist_load()&&!strcmp(persist_last_error(),"invalid_record"),"unsealed v13");
 load_fixture();wr(flash+20,rd(flash+20)^1u);reboot();CHECK(!persist_load()&&!strcmp(persist_last_error(),"invalid_record"),"v13 bad CRC word");
 /* Wrong length / board / unknown schema with our magic: never migrated, erased or overwritten. */
 uint8_t p[1024];memset(p,0,sizeof p);memcpy(p,v13_payload(),256);
 static const struct{uint32_t schema,len;}inc[]={{13,1024},{14,256},{12,256},{15,1024},{1,256}};
 for(unsigned i=0;i<sizeof inc/sizeof inc[0];i++){
  memset(flash,255,sizeof flash);put_record(0,inc[i].schema,tag,1,p,inc[i].len,true);reboot();unsigned e=flash_erases;
  CHECK(!persist_load()&&!strcmp(persist_last_error(),"fresh_install_required"),"schema %u len %u: %s",inc[i].schema,inc[i].len,persist_last_error());
  CHECK(!persist_save()&&!strcmp(persist_last_error(),"fresh_install_required")&&flash_erases==e,"save over incompatible schema %u",inc[i].schema);
 }
 memset(flash,255,sizeof flash);memcpy(flash,settings_v13_record,SETTINGS_V13_RECORD_BYTES);wr(flash+8,tag^1u);reboot();
 CHECK(!persist_load()&&!strcmp(persist_last_error(),"fresh_install_required"),"foreign board v13");
 /* Torn v14 in slot 1 next to a sealed v13: v13 wins, and the next save reuses slot 1. */
 load_fixture();memset(p+256,0,768);wr(p+256,LAYOUT_BYTES);put_record(SLOT1,14,tag,2,p,1024,false);reboot();
 CHECK(persist_load()&&!strcmp(persist_stored_schema(),"13"),"unsealed v14 must fall back to v13");
 config_board_alignment_activate();CHECK(persist_save()&&!memcmp(flash,settings_v13_record,SETTINGS_V13_RECORD_BYTES)&&rd(flash+SLOT1+16)==2,"save after torn v14");
 /* Read failure is storage_io. */
 load_fixture();reboot();flash_read_fail=true;CHECK(!persist_load()&&!strcmp(persist_last_error(),"storage_io"),"read failure");flash_read_fail=false;
}

static void test_layout_bytes(void){
 const uint32_t tag=rd(settings_v13_record+8);uint8_t p[1024];
 /* Newer layout (written by newer firmware): refused, never overwritten. */
 memset(p,0,sizeof p);memcpy(p,v13_payload(),256);wr(p+256,LAYOUT_BYTES+4u);
 memset(flash,255,sizeof flash);put_record(0,14,tag,5,p,1024,true);reboot();unsigned e=flash_erases;
 CHECK(!persist_load()&&!strcmp(persist_last_error(),"newer_settings")&&!strcmp(persist_state(),"error")&&!strcmp(persist_stored_schema(),"14"),"newer layout: %s",persist_last_error());
 CHECK(!persist_save()&&!strcmp(persist_last_error(),"newer_settings")&&flash_erases==e,"save over newer layout refused");
 /* layout below the N3 minimum, misaligned, beyond payload, or nonzero reserved bytes. */
 static const uint32_t badlen[]={0,256,258,262,1028};
 for(unsigned i=0;i<sizeof badlen/sizeof badlen[0];i++){memset(p+256,0,768);wr(p+256,badlen[i]);memset(flash,255,sizeof flash);put_record(0,14,tag,5,p,1024,true);reboot();
  CHECK(!persist_load()&&!strcmp(persist_last_error(),"invalid_settings"),"layout %u: %s",(unsigned)badlen[i],persist_last_error());}
 memset(p+256,0,768);wr(p+256,LAYOUT_BYTES);p[1023]=1;memset(flash,255,sizeof flash);put_record(0,14,tag,5,p,1024,true);reboot();
 CHECK(!persist_load()&&!strcmp(persist_last_error(),"invalid_settings"),"nonzero reserved byte");
 /* A valid v14 with the v13 field set still validated: a bad v13-region byte is refused. */
 memset(p,0,sizeof p);memcpy(p,v13_payload(),256);wr(p+256,LAYOUT_BYTES);p[77]=3;memset(flash,255,sizeof flash);put_record(0,14,tag,5,p,1024,true);reboot();
 CHECK(!persist_load()&&!strcmp(persist_last_error(),"invalid_settings"),"v14 with invalid mode count");
}

int main(void){
 test_defaults_single_source();
 test_migration();
 test_migration_power_cut();
 test_corruption();
 test_layout_bytes();
 if(failures){fprintf(stderr,"%d failure(s)\n",failures);return 1;}
 puts("PASS schema 14: byte-exact v13 fixture migrates (values kept, bytes 0..255 identical, v13 kept until first v14 save), round trip, power cuts, CRC/seal/length/board/schema corruption, layout_bytes rules, one defaults source (boot == defaults() == defaults <group> == export diff)");
 return 0;
}
