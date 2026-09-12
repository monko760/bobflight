/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "sched/scheduler.h"
#include "sched/tasks.h"
#include "hal/hal.h"

static scheduler_stats_t g_stats;
static uint32_t g_gyro_period_us;
static uint32_t g_pid_denom;
static uint32_t g_gyro_count;
static uint64_t g_next_gyro_us;

void scheduler_init(uint32_t gyro_hz, uint32_t pid_process_denom)
{
    if (gyro_hz == 0) {
        gyro_hz = 8000;
    }
    if (pid_process_denom == 0) {
        pid_process_denom = 2;
    }
    g_stats.gyro_hz = gyro_hz;
    g_stats.pid_process_denom = pid_process_denom;
    g_stats.cascade_runs = 0;
    g_stats.bg_runs = 0;
    g_gyro_period_us = 1000000u / gyro_hz;
    g_pid_denom = pid_process_denom;
    g_gyro_count = 0;
    g_next_gyro_us = hal_micros();
}

void scheduler_run(void)
{
    bg_rx_poll(); bg_failsafe_tick();
    const uint64_t now = hal_micros();

    if (now >= g_next_gyro_us) {
        g_next_gyro_us = now + g_gyro_period_us;
        /* Catch up gently if we fell behind (host smoke / USB stalls). */
        if (g_next_gyro_us + (g_gyro_period_us * 4u) < now) {
            g_next_gyro_us = now + g_gyro_period_us;
        }

        loop_gyro();
        g_gyro_count++;

        if ((g_gyro_count % g_pid_denom) == 0u) {
            loop_filter();
            loop_pid();
            loop_mixer_dshot();
            g_stats.cascade_runs++;
        }
        return;
    }

    /* Background when cascade not due */
    bg_rx_poll();
    bg_cli_poll();
    bg_failsafe_tick();
    g_stats.bg_runs++;
}

const scheduler_stats_t *scheduler_stats(void)
{
    return &g_stats;
}
