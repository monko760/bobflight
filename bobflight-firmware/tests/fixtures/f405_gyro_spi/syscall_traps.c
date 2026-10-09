/* SPDX-License-Identifier: Apache-2.0
 * Standalone register-model executable, not production firmware.
 * Newlib's real libm includes error paths that reference OS services. Link those
 * paths, but fail the test if any is executed. Never emulate successful I/O or
 * heap allocation, and never replace the real mounting trigonometry.
 */
#include <stdint.h>
#include <stddef.h>
#include <sys/stat.h>
extern volatile uint32_t fixture_error;
extern __attribute__((noreturn)) void fixture_done(void);
static __attribute__((noreturn)) void syscall_trap(unsigned id){fixture_error=0xff000000u|id;fixture_done();}
void *_sbrk(ptrdiff_t increment){(void)increment;syscall_trap(1);}
__attribute__((noreturn)) void _exit(int status){(void)status;syscall_trap(2);}
int _kill(int pid,int signal){(void)pid;(void)signal;syscall_trap(3);}
int _getpid(void){syscall_trap(4);}
int _write(int fd,const void *data,size_t count){(void)fd;(void)data;(void)count;syscall_trap(5);}
int _read(int fd,void *data,size_t count){(void)fd;(void)data;(void)count;syscall_trap(6);}
int _close(int fd){(void)fd;syscall_trap(7);}
int _fstat(int fd,struct stat *out){(void)fd;(void)out;syscall_trap(8);}
int _isatty(int fd){(void)fd;syscall_trap(9);}
long _lseek(int fd,long offset,int whence){(void)fd;(void)offset;(void)whence;syscall_trap(10);}
