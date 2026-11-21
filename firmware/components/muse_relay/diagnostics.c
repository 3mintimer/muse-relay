// SPDX-License-Identifier: MIT
#include "diagnostics.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "noise_control.h"
#include "nvs.h"
#include "wifi_mgr.h"

#define D_RESTARTING 5
#define HISTORY 12
#define PERIOD 60
#define STALL 180
#define RECONNECT_GRACE 120
#define RETRY 15
static atomic_int reconnect_result;
static atomic_int phase, poll_code, transport_error, tls_error;
static atomic_uint progress, poll_ok;
static const char *base_url, *device_token, *gateway_token;
static uint32_t boot_id;
static unsigned seconds(void) { return (unsigned)(esp_timer_get_time() / 1000000); }

bool diag_begin_poll(void)
{
    int expected = D_IDLE;
    if (!atomic_compare_exchange_strong(&phase, &expected, D_POLL))
        return false;
    atomic_store(&progress, seconds());
    return true;
}

void diag_phase(diag_phase_t next)
{
    atomic_store(&progress, seconds());
    int current = atomic_load(&phase);
    while (current != D_RESTARTING && !atomic_compare_exchange_weak(&phase, &current, next)) {
    }
}

void diag_poll_result(int code, int transport, int tls, bool valid)
{
    atomic_store(&poll_code, code);
    atomic_store(&transport_error, transport);
    atomic_store(&tls_error, tls);
    if (valid)
        atomic_store(&poll_ok, seconds());
}

enum event {
    BOOT = 1,
    WIFI_DOWN,
    WIFI_UP,
    MUSE_DOWN,
    MUSE_UP,
    POLL_ERROR,
    POLL_OK,
    DIAG_ERROR,
    DIAG_OK,
    STALLED,
    RECONNECT,
    RESTART,
    RECONNECT_FAILED,
    POLL_TRANSPORT,
    POLL_TLS,
    COMMAND_DEFERRED
};
typedef struct {
    uint32_t boot, at;
    int32_t event, detail;
} entry_t;
typedef struct {
    entry_t rows[HISTORY];
    uint32_t head;
    char command[37];
    int action;
    uint32_t command_boot;
} journal_t;
static journal_t journal;
static nvs_handle_t storage;
static bool have_storage;
static unsigned saved;
static bool dirty;

static bool save(void)
{
    if (!have_storage || nvs_set_blob(storage, "journal", &journal, sizeof(journal)) != ESP_OK ||
        nvs_commit(storage) != ESP_OK)
        return false;
    dirty = false;
    saved = seconds();
    return true;
}

static void record(enum event event, int detail)
{
    journal.rows[journal.head++ % HISTORY] = (entry_t){boot_id, seconds(), event, detail};
    dirty = true;
}

// Only the diagnostics task touches this client's buffers and journal.
static char payload[1536], auth[1040], response_text[256];
static size_t response_len;
static bool overflow;

static esp_err_t collect(esp_http_client_event_t *e)
{
    if (e->event_id == HTTP_EVENT_ON_DATA) {
        if (e->data_len < 0 || (size_t)e->data_len >= sizeof(response_text) - response_len)
            overflow = true;
        else {
            memcpy(response_text + response_len, e->data, e->data_len);
            response_len += e->data_len;
            response_text[response_len] = 0;
        }
    }
    return ESP_OK;
}

static bool report(bool wifi, bool muse, int *failure)
{
    *failure = -1;
    int activity = atomic_load(&phase);
    unsigned last = atomic_load(&poll_ok), count = journal.head < HISTORY ? journal.head : HISTORY;
    int n = snprintf(
        payload, sizeof(payload),
        "{\"fw\":\"%s\",\"boot\":%lu,\"uptime\":%u,\"wifi\":%d,\"muse\":%d,\"phase\":%d,"
        "\"poll\":%d,\"transport\":%d,\"tls\":%d,\"poll_age\":%d,\"command\":\"%s\","
        "\"action\":%d,\"command_boot\":%lu,\"history\":[",
        esp_app_get_description()->version, (unsigned long)boot_id, seconds(), wifi, muse,
        activity == D_RESTARTING ? D_RECOVERY : activity, atomic_load(&poll_code),
        atomic_load(&transport_error), atomic_load(&tls_error), last ? (int)(seconds() - last) : -1,
        journal.command, journal.action, (unsigned long)journal.command_boot);
    for (unsigned i = 0; i < count; ++i) {
        if (n < 0 || (size_t)n >= sizeof(payload))
            return false;
        entry_t row = journal.rows[(journal.head - count + i) % HISTORY];
        n += snprintf(payload + n, sizeof(payload) - n, "%s[%lu,%lu,%d,%d]", i ? "," : "",
                      (unsigned long)row.boot, (unsigned long)row.at, (int)row.event,
                      (int)row.detail);
    }
    if (n < 0 || (size_t)n + 3 > sizeof(payload))
        return false;
    strcpy(payload + n, "]}");
    char url[300];
    snprintf(url, sizeof(url), "%s/device/diagnostics", base_url);
    esp_http_client_config_t config = {.url = url,
                                       .method = HTTP_METHOD_POST,
                                       .timeout_ms = 6000,
                                       .buffer_size = 1024,
                                       .buffer_size_tx = 2048,
                                       .crt_bundle_attach = esp_crt_bundle_attach,
                                       .disable_auto_redirect = true,
                                       .event_handler = collect};
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client)
        return false;
    response_len = 0;
    overflow = false;
    response_text[0] = 0;
    snprintf(auth, sizeof(auth), "Bearer %s", device_token);
    bool ok = esp_http_client_set_header(client, "Authorization", auth) == ESP_OK;
    if (*gateway_token) {
        snprintf(auth, sizeof(auth), "Bearer %s", gateway_token);
        ok = ok && esp_http_client_set_header(client, "OAI-Sites-Authorization", auth) == ESP_OK;
    }
    ok = ok && esp_http_client_set_header(client, "Content-Type", "application/json") == ESP_OK &&
         esp_http_client_set_post_field(client, payload, strlen(payload)) == ESP_OK;
    if (ok) {
        esp_err_t err = esp_http_client_perform(client);
        int status = esp_http_client_get_status_code(client);
        ok = err == ESP_OK && status == 200 && !overflow;
        *failure = err != ESP_OK ? -(int)err : (overflow ? -2 : status);
    }
    esp_http_client_cleanup(client);
    return ok;
}

static void reconnect_task(void *unused)
{
    noise_ctrl_disconnect();
    bool ok = noise_ctrl_reconnect(NULL);
    atomic_store(&reconnect_result, ok ? 1 : -1);
    diag_phase(D_IDLE);
    vTaskDelete(NULL);
}

static bool recover(bool reboot, const char *id, int required_phase, bool stalled)
{
    int expected = required_phase;
    if (!atomic_compare_exchange_strong(&phase, &expected, reboot ? D_RESTARTING : D_RECOVERY))
        return false;
    // A stuck poll may have returned concurrently. Its owner uses CAS before
    // entering a job or OTA, so it cannot begin new work after this claim.
    journal_t previous = journal;
    if (id) {
        strlcpy(journal.command, id, sizeof(journal.command));
        journal.action = reboot ? 2 : 1;
        journal.command_boot = boot_id;
    }
    if (stalled)
        record(STALLED, (int)(seconds() - atomic_load(&progress)));
    record(reboot ? RESTART : RECONNECT, id != NULL);
    if (!save()) {
        journal = previous;
        atomic_store(&phase, required_phase);
        return false;
    }
    if (reboot)
        esp_restart();
    if (xTaskCreate(reconnect_task, "relay_reconnect", 4096, NULL, 4, NULL) != pdPASS) {
        record(RECONNECT_FAILED, 0);
        save();
        diag_phase(D_IDLE);
    }
    return true;
}

bool diag_claim_after_poll(diag_phase_t next)
{
    int expected = D_POLL;
    return atomic_compare_exchange_strong(&phase, &expected, next);
}

static void diagnostics_task(void *unused)
{
    have_storage = nvs_open("relay_diag", NVS_READWRITE, &storage) == ESP_OK;
    if (have_storage) {
        size_t n = sizeof(journal);
        if (nvs_get_blob(storage, "journal", &journal, &n) != ESP_OK || n != sizeof(journal))
            memset(&journal, 0, sizeof(journal));
    }
    record(BOOT, esp_reset_reason());
    save();
    int prev_wifi = -1, prev_muse = -1, prev_poll = 0, prev_diag = -1, prev_phase = -1;
    char deferred[37] = "";
    int prev_transport = 0, prev_tls = 0;
    unsigned next = 0, muse_down = 0, auto_attempt = 0, stuck_since = 0, last_progress = 0;
    for (;;) {
        unsigned now = seconds();
        int wifi = wifi_mgr_is_connected(), muse = noise_ctrl_is_connected();
        int current = atomic_load(&phase), code = atomic_load(&poll_code);
        bool changed = false;
        int result = atomic_exchange(&reconnect_result, 0);
        if (result < 0) {
            record(RECONNECT_FAILED, 1);
            changed = true;
        }
        if (wifi != prev_wifi) {
            record(wifi ? WIFI_UP : WIFI_DOWN, 0);
            prev_wifi = wifi;
            changed = true;
        }
        if (muse != prev_muse) {
            record(muse ? MUSE_UP : MUSE_DOWN, 0);
            prev_muse = muse;
            changed = true;
        }
        if (code != prev_poll) {
            record(code == 200 ? POLL_OK : POLL_ERROR, code);
            prev_poll = code;
            changed = true;
        }
        int transport = atomic_load(&transport_error), tls = atomic_load(&tls_error);
        if (transport && transport != prev_transport) {
            record(POLL_TRANSPORT, transport);
            changed = true;
        }
        if (tls && tls != prev_tls) {
            record(POLL_TLS, tls);
            changed = true;
        }
        prev_transport = transport;
        prev_tls = tls;
        // A normal 2-second poll is not a state transition worth posting.
        int activity = current == D_POLL ? D_IDLE : current;
        if (prev_phase != activity) {
            changed = true;
            prev_phase = activity;
        }
        if (!wifi || muse) {
            muse_down = 0;
            auto_attempt = 0;
        } else if (!muse_down)
            muse_down = now;
        if (dirty && now - saved >= 30)
            save();
        // A failed HTTP request that returns is progress. External outages
        // with a responsive poller must not cause repeated reboots.
        unsigned tick = atomic_load(&progress);
        if (!wifi || !atomic_load(&poll_ok) || current == D_JOB || current == D_OTA ||
            (current == D_IDLE && !muse) || tick != last_progress)
            stuck_since = 0;
        else if (!stuck_since)
            stuck_since = now;
        last_progress = tick;
        if (stuck_since && now - stuck_since >= STALL &&
            (current == D_POLL || current == D_IDLE || current == D_RECOVERY))
            recover(true, NULL, current, true);
        if (wifi && (now >= next || (changed && prev_diag != 0))) {
            int failure;
            bool ok = report(wifi, muse, &failure);
            next = seconds() + (ok ? PERIOD : RETRY);
            if ((int)ok != prev_diag) {
                record(ok ? DIAG_OK : DIAG_ERROR, ok ? 0 : failure);
                prev_diag = ok;
            }
            if (ok) {
                cJSON *root = cJSON_Parse(response_text);
                const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(root, "id"));
                const char *action = cJSON_GetStringValue(cJSON_GetObjectItem(root, "action"));
                cJSON *ttl = cJSON_GetObjectItem(root, "ttl");
                bool command = id && strlen(id) == 36 && strspn(id, "abcdef0123456789-") == 36 &&
                               action &&
                               (!strcmp(action, "reboot") || !strcmp(action, "reconnect")) &&
                               cJSON_IsNumber(ttl) && ttl->valueint > (int)(seconds() - now) &&
                               strcmp(journal.command, id);
                if (command) {
                    bool ran = recover(!strcmp(action, "reboot"), id, D_IDLE, false);
                    int busy = atomic_load(&phase);
                    if (!ran && (busy == D_JOB || busy == D_OTA) && strcmp(deferred, id)) {
                        strlcpy(deferred, id, sizeof(deferred));
                        record(COMMAND_DEFERRED, busy);
                    }
                    next = seconds() + (ran ? 2 : 5);
                } else if (muse_down && now - muse_down >= RECONNECT_GRACE &&
                           (!auto_attempt || now - auto_attempt >= 600) &&
                           recover(false, NULL, D_IDLE, false)) {
                    auto_attempt = now;
                    next = seconds() + 5;
                }
                cJSON_Delete(root);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void diag_start(const char *url, const char *token, const char *gateway, uint32_t boot)
{
    if (strncmp(url, "https://", 8))
        return;
    base_url = url;
    device_token = token;
    gateway_token = gateway;
    boot_id = boot;
    if (xTaskCreate(diagnostics_task, "relay_diag", 6144, NULL, 3, NULL) != pdPASS)
        ESP_LOGE("relay_diag", "could not start diagnostics");
}
