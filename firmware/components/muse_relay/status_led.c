// SPDX-License-Identifier: MIT
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include "driver/rmt_tx.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "noise_control.h"
#include "soc/soc_caps.h"
#include "status_led.h"
#include "wifi_mgr.h"

// AtomS3 Lite has one WS2812C-2020 on GPIO35. The pixel takes GRB bytes.
#define LED_GPIO GPIO_NUM_35
#define LED_TICK_US 100000

static const char *TAG = "relay_led";
static DRAM_ATTR const uint8_t s_grb[][3] = {
    [RELAY_LED_OFF] = {0, 0, 0},
    [RELAY_LED_OFFLINE] = {0, 24, 0},
    [RELAY_LED_DISCONNECTED] = {5, 20, 0},
    [RELAY_LED_READY] = {12, 0, 0},
    [RELAY_LED_BUSY] = {0, 0, 24},
    [RELAY_LED_RESPONDING] = {0, 16, 24},
};
static atomic_int s_relay_state = RELAY_LED_READY;
static atomic_int s_displayed_state = RELAY_LED_OFF;
static atomic_bool s_internet_reachable = true;
static rmt_channel_handle_t s_channel;
static rmt_encoder_handle_t s_encoder;

static void update_led(void *unused)
{
    (void)unused;
    static relay_led_state_t previous_state = RELAY_LED_OFF;
    static relay_led_state_t last_color = RELAY_LED_OFF;
    static int64_t state_started, last_sent;
    int64_t now = esp_timer_get_time();
    relay_led_state_t state;
    if (!wifi_mgr_is_connected() || !atomic_load_explicit(&s_internet_reachable, memory_order_relaxed)) {
        state = RELAY_LED_OFFLINE;
    } else if (!noise_ctrl_is_connected()) {
        state = RELAY_LED_DISCONNECTED;
    } else {
        state = atomic_load_explicit(&s_relay_state, memory_order_relaxed);
    }
    if (state != previous_state) {
        previous_state = state;
        state_started = now;
    }
    int64_t elapsed_ms = (now - state_started) / 1000;
    relay_led_state_t color = state;
    if ((state == RELAY_LED_DISCONNECTED && elapsed_ms % 1000 >= 200)
        || (state == RELAY_LED_BUSY && elapsed_ms % 1200 >= 600)) {
        color = RELAY_LED_OFF;
    }
    if (color != last_color) {
        // Leave time for the previous frame to latch if callbacks ran late.
        if (now - last_sent < 1000) return;
        const rmt_transmit_config_t tx = { .flags.queue_nonblocking = true };
        // The static payload remains valid while RMT transmits it.
        if (rmt_transmit(s_channel, s_encoder, s_grb[color], sizeof(s_grb[color]), &tx) != ESP_OK) return;
        last_color = color;
        last_sent = now;
    }
    atomic_store_explicit(&s_displayed_state, state, memory_order_relaxed);
}

void relay_led_set_state(relay_led_state_t state)
{
    atomic_store_explicit(&s_relay_state, state, memory_order_relaxed);
}

void relay_led_set_internet_reachable(bool reachable)
{
    atomic_store_explicit(&s_internet_reachable, reachable, memory_order_relaxed);
}

const char *relay_led_state_name(void)
{
    static const char *const names[] = {
        [RELAY_LED_OFF] = "off",
        [RELAY_LED_OFFLINE] = "offline",
        [RELAY_LED_DISCONNECTED] = "muse_disconnected",
        [RELAY_LED_READY] = "ready",
        [RELAY_LED_BUSY] = "busy",
        [RELAY_LED_RESPONDING] = "responding",
    };
    return names[atomic_load_explicit(&s_displayed_state, memory_order_relaxed)];
}

void relay_led_start(void)
{
    const rmt_tx_channel_config_t channel = {
        .gpio_num = LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10000000,
        .mem_block_symbols = SOC_RMT_MEM_WORDS_PER_CHANNEL,
        .trans_queue_depth = 1,
    };
    // WS2812 bit times in 100 ns ticks. The line idles low between frames.
    const rmt_bytes_encoder_config_t encoder = {
        .bit0 = { .level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9 },
        .bit1 = { .level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3 },
        .flags.msb_first = true,
    };
    const esp_timer_create_args_t timer_config = {
        .callback = update_led,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "relay_led",
        .skip_unhandled_events = true,
    };
    esp_timer_handle_t timer = NULL;
    esp_err_t err = rmt_new_tx_channel(&channel, &s_channel);
    if (err == ESP_OK) err = rmt_new_bytes_encoder(&encoder, &s_encoder);
    if (err == ESP_OK) err = rmt_enable(s_channel);
    bool enabled = err == ESP_OK;
    if (err == ESP_OK) err = esp_timer_create(&timer_config, &timer);
    if (err == ESP_OK) err = esp_timer_start_periodic(timer, LED_TICK_US);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Status LED ready on GPIO%d", LED_GPIO);
        return;
    }
    if (timer) esp_timer_delete(timer);
    if (enabled) rmt_disable(s_channel);
    if (s_encoder) rmt_del_encoder(s_encoder);
    if (s_channel) rmt_del_channel(s_channel);
    ESP_LOGW(TAG, "Status LED unavailable: %s", esp_err_to_name(err));
}
