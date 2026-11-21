// SPDX-License-Identifier: MIT
#pragma once
#include "sdkconfig.h"
#include "esp_http_client.h"
#include "cJSON.h"
#if CONFIG_MUSE_RELAY_ATOMS3_LITE_LED
#define MUSE_RELAY_OTA_TARGET "muse-relay/atoms3-lite/8m-ab-v1"
#else
#define MUSE_RELAY_OTA_TARGET "muse-relay/atoms3/8m-ab-v1"
#endif
bool muse_relay_ota_healthy(void);
void relay_ota_connected(void);
const char *relay_ota_target(void);
void relay_ota_offer(cJSON *offer, esp_http_client_handle_t http, bool https, bool (*prepare_get)(const char *));
void relay_ota_report(int (*post)(const char *));
