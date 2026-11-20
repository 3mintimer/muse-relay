// SPDX-License-Identifier: MIT
#pragma once

#include <stdbool.h>
#include "sdkconfig.h"

typedef enum {
    RELAY_LED_OFF,
    RELAY_LED_OFFLINE,
    RELAY_LED_DISCONNECTED,
    RELAY_LED_READY,
    RELAY_LED_BUSY,
    RELAY_LED_RESPONDING,
} relay_led_state_t;

#if CONFIG_MUSE_RELAY_ATOMS3_LITE_LED
void relay_led_start(void);
void relay_led_set_state(relay_led_state_t state);
void relay_led_set_internet_reachable(bool reachable);
const char *relay_led_state_name(void);
#else
static inline void relay_led_start(void) {}
static inline void relay_led_set_state(relay_led_state_t state) { (void)state; }
static inline void relay_led_set_internet_reachable(bool reachable) { (void)reachable; }
static inline const char *relay_led_state_name(void) { return "off"; }
#endif
