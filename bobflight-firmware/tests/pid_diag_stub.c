/* SPDX-License-Identifier: Apache-2.0
 * Existing task tests replace independent diagnostic entry point; dedicated
 * host_pid_diag tests exercise its real implementation with deterministic IO. */
#include <stdint.h>
void pid_diag_update(uint64_t t,const float g[3]){(void)t;(void)g;}
