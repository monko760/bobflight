/* SPDX-License-Identifier: Apache-2.0
 * Host task-loop tests stub gyro_filter and cannot link drivers/gyro.c.
 * loop_filter() also needs gyro_filter_set_dt after Filters R0. */
void gyro_filter_set_dt(float dt) { (void)dt; }
