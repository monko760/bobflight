/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * BobFlight version metadata (clean-room; independent of Betaflight).
 */
#ifndef BOBFLIGHT_VERSION_H
#define BOBFLIGHT_VERSION_H

#define BOBFLIGHT_VERSION_MAJOR 0
#define BOBFLIGHT_VERSION_MINOR 2
#define BOBFLIGHT_VERSION_PATCH 0
#if defined(BOBFLIGHT_TARGET_TMOTORF7V2)
#define BOBFLIGHT_VERSION_STRING "0.2.0-prototype-tmotorf7v2-sensor2-bl1-calstore1"
#else
#define BOBFLIGHT_VERSION_STRING "0.2.0-prototype-switchbench2-bl1-calstore1"
#endif

#define BOBFLIGHT_PRODUCT_NAME "BobFlight"

#endif /* BOBFLIGHT_VERSION_H */
