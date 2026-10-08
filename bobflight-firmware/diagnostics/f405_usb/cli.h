/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BF_F405_DIAGNOSTIC_CLI_H
#define BF_F405_DIAGNOSTIC_CLI_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
typedef enum { DIAG_NONE, DIAG_HELP, DIAG_STATUS, DIAG_VERSION, DIAG_BAD } diag_cmd_t;
typedef struct { char line[32]; uint8_t used; bool discard; } diag_cli_t;
static inline void diag_cli_reset(diag_cli_t *s) { memset(s,0,sizeof(*s)); }
/* Reject overlong/control-containing lines as a whole, never execute a prefix. */
static inline diag_cmd_t diag_cli_feed(diag_cli_t *s, uint8_t c)
{
    if(c=='\r'||c=='\n') {
        diag_cmd_t result=DIAG_NONE;
        s->line[s->used]=0;
        if(s->discard)result=DIAG_BAD;
        else if(s->used) {
            if(!strcmp(s->line,"help"))result=DIAG_HELP;
            else if(!strcmp(s->line,"status"))result=DIAG_STATUS;
            else if(!strcmp(s->line,"version"))result=DIAG_VERSION;
            else result=DIAG_BAD;
        }
        diag_cli_reset(s);return result;
    }
    if(s->discard)return DIAG_NONE;
    if(c==8||c==127) { if(s->used)s->used--;return DIAG_NONE; }
    if(c<32||c>126||s->used==sizeof(s->line)-1u)s->discard=true;
    else s->line[s->used++]=(char)c;
    return DIAG_NONE;
}
#endif
