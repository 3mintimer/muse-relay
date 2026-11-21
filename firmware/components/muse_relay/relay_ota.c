// SPDX-License-Identifier: MIT
#include "relay_ota.h"
#include "esp_app_desc.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "nvs.h"
#include "psa/crypto.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include "esp_partition.h"

static atomic_bool relay_online;
static const char *TAG = "muse_ota";

bool muse_relay_ota_healthy(void) { return atomic_load(&relay_online); }
void relay_ota_connected(void) { atomic_store(&relay_online, true); }

// This marker is also checked by the release packager before offering a binary.
const char *relay_ota_target(void) { return MUSE_RELAY_OTA_TARGET; }

static bool parse_version(const char *s, int v[3])
{
    if (!s) return false;
    for (int i = 0; i < 3; ++i) {
        if (!isdigit((unsigned char)*s)) return false;
        char *end;
        long n = strtol(s, &end, 10);
        if (n > 9999 || (end - s > 1 && *s == '0')) return false;
        v[i] = (int)n;
        if (i == 2) return *end == 0;
        if (*end != '.') return false;
        s = end + 1;
    }
    return false;
}

static bool newer(const char *candidate)
{
    int a[3], b[3];
    if (!parse_version(candidate, a) || !parse_version(esp_app_get_description()->version, b)) return false;
    for (int i = 0; i < 3; ++i) if (a[i] != b[i]) return a[i] > b[i];
    return false;
}

static bool download(esp_http_client_handle_t http, const esp_partition_t *slot,
                     int size, const char *expected, const char *version)
{
    if (esp_http_client_open(http, 0) != ESP_OK) return false;
    bool ok = false;
    esp_ota_handle_t ota = 0;
    psa_hash_operation_t hash = PSA_HASH_OPERATION_INIT;
    if (esp_http_client_fetch_headers(http) != size || esp_http_client_get_status_code(http) != 200 ||
        psa_hash_setup(&hash, PSA_ALG_SHA_256) != PSA_SUCCESS ||
        esp_ota_begin(slot, size, &ota) != ESP_OK) goto done;

    uint8_t buf[1024], digest[32];
    for (int total = 0; total < size;) {
        int n = esp_http_client_read(http, (char *)buf, sizeof(buf));
        if (n <= 0 || n > size - total || psa_hash_update(&hash, buf, n) != PSA_SUCCESS ||
            esp_ota_write(ota, buf, n) != ESP_OK) goto done;
        total += n;
    }
    size_t written;
    if (psa_hash_finish(&hash, digest, sizeof(digest), &written) != PSA_SUCCESS || written != 32) goto done;
    char hex[65];
    for (int i = 0; i < 32; ++i) snprintf(hex + 2*i, 3, "%02x", digest[i]);
    if (strcmp(hex, expected)) goto done;
    esp_err_t err = esp_ota_end(ota);
    ota = 0;
    esp_app_desc_t desc;
    if (err == ESP_OK && esp_ota_get_partition_description(slot, &desc) == ESP_OK &&
        !strncmp(desc.project_name, esp_app_get_description()->project_name, sizeof(desc.project_name)) &&
        !strncmp(desc.version, version, sizeof(desc.version))) {
        const void *image;
        esp_partition_mmap_handle_t mapping;
        if (esp_partition_mmap(slot, 0, size, ESP_PARTITION_MMAP_DATA, &image, &mapping) == ESP_OK) {
            const char *target = relay_ota_target();
            bool matches = memmem(image, size, target, strlen(target) + 1) != NULL;
            esp_partition_munmap(mapping);
            ok = matches && esp_ota_set_boot_partition(slot) == ESP_OK;
        }
    }
done:
    if (ota) esp_ota_abort(ota);
    psa_hash_abort(&hash);
    esp_http_client_close(http);
    return ok;
}

void relay_ota_offer(cJSON *offer, esp_http_client_handle_t http, bool https,
                     bool (*prepare_get)(const char *))
{
    if (!https || !cJSON_IsObject(offer)) return;
    const char *target = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(offer, "target"));
    const char *sha = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(offer, "sha256"));
    const char *version = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(offer, "version"));
    cJSON *bytes = cJSON_GetObjectItemCaseSensitive(offer, "size");
    const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
    esp_ota_img_states_t state;
    if (!target || strcmp(target, relay_ota_target()) || !newer(version) || !sha ||
        strlen(sha) != 64 || strspn(sha, "0123456789abcdef") != 64 ||
        !slot || !cJSON_IsNumber(bytes) || bytes->valueint != bytes->valuedouble ||
        bytes->valueint <= 0 || bytes->valuedouble > slot->size ||
        esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) != ESP_OK ||
        state != ESP_OTA_IMG_VALID) return;

    cJSON *generation = cJSON_GetObjectItemCaseSensitive(offer, "generation");
    if (!cJSON_IsNumber(generation) || generation->valueint < 1 ||
        generation->valuedouble != generation->valueint) return;
    char attempt_id[80], last[80] = {0};
    snprintf(attempt_id, sizeof(attempt_id), "%s.%d", sha, generation->valueint);
    size_t len = sizeof(last);
    nvs_handle_t nvs;
    if (nvs_open("muse-relay", NVS_READWRITE, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_get_str(nvs, "ota_attempt", last, &len);
    bool attempt = (err == ESP_ERR_NVS_NOT_FOUND || (err == ESP_OK && strcmp(attempt_id, last))) &&
        nvs_set_str(nvs, "ota_attempt", attempt_id) == ESP_OK &&
        nvs_set_str(nvs, "ota_version", version) == ESP_OK && nvs_commit(nvs) == ESP_OK;
    nvs_close(nvs);
    if (!attempt) return;

    char path[100];
    snprintf(path, sizeof(path), "/device/firmware/%s", sha);
    ESP_LOGI(TAG, "downloading %s to %s", version, slot->label);
    if (prepare_get(path) && download(http, slot, bytes->valueint, sha, version)) {
        ESP_LOGI(TAG, "verified %s, rebooting", version);
        esp_restart();
    }
    ESP_LOGW(TAG, "update failed; retaining current slot");
}

void relay_ota_report(int (*post)(const char *))
{
    // Re-send on boot, a state change, or after a transient report failure.
    static char sent[256];
    nvs_handle_t nvs;
    if (nvs_open("muse-relay", NVS_READONLY, &nvs) != ESP_OK) return;
    char attempt[80], version[32];
    size_t a = sizeof(attempt), v = sizeof(version);
    bool have = nvs_get_str(nvs, "ota_attempt", attempt, &a) == ESP_OK &&
                nvs_get_str(nvs, "ota_version", version, &v) == ESP_OK;
    nvs_close(nvs);
    if (!have) return;
    esp_ota_img_states_t state;
    const esp_partition_t *slot = esp_ota_get_running_partition();
    if (esp_ota_get_state_partition(slot, &state) != ESP_OK) return;
    const char *running = esp_app_get_description()->version;
    const char *status = state == ESP_OTA_IMG_PENDING_VERIFY ? "verifying" :
                         strcmp(version, running) ? "previous_running" : "confirmed";
    char json[256];
    int n = snprintf(json, sizeof(json),
        "{\"attempt\":\"%s\",\"version\":\"%s\",\"slot\":\"%s\",\"status\":\"%s\"}",
        attempt, running, slot->label, status);
    if (n > 0 && n < sizeof(json) && strcmp(json, sent) && post(json) == 200)
        memcpy(sent, json, n + 1);
}
