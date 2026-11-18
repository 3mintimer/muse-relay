// SPDX-License-Identifier: MIT
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "cJSON.h"
#include "driver/gpio.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "noise_control.h"
#include "sdkconfig.h"
#include "chat_filter.h"

#define CHUNK 1024
#define ACK_CAP 4096
#define HTTP_CAP 2048
#define GATEWAY_TOKEN_MAX 1024
#define MAX_REQUEST_BYTES (2 * 1024 * 1024)
#define TURN_MS 120000
#define HEARTBEAT_MS 20000

static const char *TAG = "muse_relay";
typedef struct {
    char data[HTTP_CAP];
    size_t len;
    bool overflow;
} http_reply_t;

static SemaphoreHandle_t s_lock;
static uint32_t s_generation;
static bool s_overflow, s_ack_done;
static bool s_sub_done;
static int s_ack_status, s_sub_status;
static int s_noise_failure;
static size_t s_ack_len;
static char s_ack[ACK_CAP];
static char s_url[256], s_token[128];
static char s_gateway_token[GATEWAY_TOKEN_MAX + 1];
static esp_http_client_handle_t s_http;
static http_reply_t s_http_reply;
static uint32_t s_boot_id, s_event_seq;
static bool s_terminal;
static bool s_subscription_fresh;
static char s_active_session[RELAY_CHAT_ID_BYTES + 1];
static relay_chat_event_t s_out_event; // Consumer task only; keep its stack small.

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

static bool valid_base_url(const char *url)
{
    bool scheme = !strncmp(url, "https://", 8);
#if CONFIG_MUSE_RELAY_ALLOW_HTTP
    scheme |= !strncmp(url, "http://", 7);
#endif
    if (!scheme || strlen(url) >= sizeof(s_url) - 64) return false;
    const char *host = strstr(url, "://") + 3;
    if (!*host || *host == '/' || strchr(host, '@')) return false;
    for (const char *p = url; *p; p++) {
        if ((unsigned char)*p <= 32 || *p == '?' || *p == '#') return false;
    }
    return true;
}

static bool valid_token(const char *value, size_t min, size_t max)
{
    size_t len = strlen(value);
    if (len < min || len > max) return false;
    for (size_t i = 0; i < len; i++) {
        if ((unsigned char)value[i] <= 32 || (unsigned char)value[i] >= 127) return false;
    }
    return true;
}

// Called by the small console hook installed by tools/prepare_sdk.py.
// Console settings are kept only on the board, never printed back.
bool muse_relay_console_command(const char *line)
{
    const char *value = NULL, *key = NULL;
    if (!strncmp(line, "relay_url=", 10)) {
        key = "url"; value = line + 10;
        if (!valid_base_url(value)) { puts("@relay error invalid_url"); return true; }
    } else if (!strncmp(line, "relay_token=", 12)) {
        key = "token"; value = line + 12;
        if (!valid_token(value, 32, sizeof(s_token) - 1)) {
            puts("@relay error invalid_token"); return true;
        }
    } else if (!strncmp(line, "relay_gateway_token=", 20)) {
        key = "gateway_token"; value = line + 20;
        // An explicit empty value removes the optional gateway header.
        if (!valid_token(value, 0, GATEWAY_TOKEN_MAX)) {
            puts("@relay error invalid_gateway_token"); return true;
        }
    } else if (!strcmp(line, "relay_status")) {
        printf("@relay {\"sdk_connected\":%s,\"configured\":%s,\"gateway_configured\":%s}\n",
            noise_ctrl_is_connected() ? "true" : "false",
            s_url[0] && s_token[0] ? "true" : "false",
            s_gateway_token[0] ? "true" : "false");
        return true;
    } else return false;
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("muse-relay", NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        err = nvs_set_str(nvs, key, value);
        if (err == ESP_OK) err = nvs_commit(nvs);
        nvs_close(nvs);
    }
    puts(err == ESP_OK ? "@relay ok saved_restart_to_apply" : "@relay error storage");
    fflush(stdout);
    return true;
}

static bool load_settings(void)
{
    nvs_handle_t nvs;
    if (nvs_open("muse-relay", NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t u = sizeof(s_url), t = sizeof(s_token);
    bool ok = nvs_get_str(nvs, "url", s_url, &u) == ESP_OK
        && nvs_get_str(nvs, "token", s_token, &t) == ESP_OK;
    size_t g = sizeof(s_gateway_token);
    esp_err_t gateway = nvs_get_str(nvs, "gateway_token", s_gateway_token, &g);
    if (gateway == ESP_ERR_NVS_NOT_FOUND) s_gateway_token[0] = 0;
    else if (gateway != ESP_OK) ok = false;
    nvs_close(nvs);
    size_t len = strlen(s_url);
    while (len && s_url[len - 1] == '/') s_url[--len] = 0;
    return ok && valid_base_url(s_url) && valid_token(s_token, 32, sizeof(s_token) - 1)
        && valid_token(s_gateway_token, 0, GATEWAY_TOKEN_MAX);
}

static esp_err_t on_http(esp_http_client_event_t *ev)
{
    if (ev->event_id == HTTP_EVENT_ON_DATA && ev->user_data) {
        http_reply_t *out = ev->user_data;
        size_t n = (size_t)ev->data_len;
        if (n >= sizeof(out->data) - out->len) out->overflow = true;
        else { memcpy(out->data + out->len, ev->data, n); out->len += n; out->data[out->len] = 0; }
    }
    return ESP_OK;
}

static bool set_http(const char *path, esp_http_client_method_t method, const char *body)
{
    char url[384], auth[GATEWAY_TOKEN_MAX + sizeof("Bearer ")];
    if (snprintf(url, sizeof(url), "%s%s", s_url, path) >= sizeof(url)) return false;
    snprintf(auth, sizeof(auth), "Bearer %s", s_token);
    memset(&s_http_reply, 0, sizeof(s_http_reply));
    bool ok = esp_http_client_set_url(s_http, url) == ESP_OK
        && esp_http_client_set_method(s_http, method) == ESP_OK
        && esp_http_client_set_header(s_http, "Authorization", auth) == ESP_OK;
    if (ok && s_gateway_token[0]) {
        snprintf(auth, sizeof(auth), "Bearer %s", s_gateway_token);
        ok = esp_http_client_set_header(s_http, "OAI-Sites-Authorization", auth) == ESP_OK;
    }
    return ok && esp_http_client_set_header(s_http, "Content-Type", "application/json") == ESP_OK
        && esp_http_client_set_post_field(s_http, body, body ? strlen(body) : 0) == ESP_OK;
}

static int request(const char *path, esp_http_client_method_t method, const char *body)
{
    if (!set_http(path, method, body)) return -1;
    esp_err_t err = esp_http_client_perform(s_http);
    if (err != ESP_OK || s_http_reply.overflow) return -1;
    return esp_http_client_get_status_code(s_http);
}

static bool post_event(const char *job_id, const char *type, const char *field, const char *value)
{
    cJSON *event = cJSON_CreateObject();
    if (!event) return false;
    char event_id[40];
    snprintf(event_id, sizeof(event_id), "%08lx-%08lx", (unsigned long)s_boot_id,
             (unsigned long)++s_event_seq);
    cJSON_AddStringToObject(event, "job_id", job_id);
    cJSON_AddStringToObject(event, "event_id", event_id);
    cJSON_AddStringToObject(event, "session_id", s_active_session);
    cJSON_AddStringToObject(event, "type", type);
    if (s_subscription_fresh && !strcmp(type, "muse_ack"))
        cJSON_AddBoolToObject(event, "subscription_fresh", true);
    if (field) cJSON_AddStringToObject(event, field, value ? value : "");
    char *json = cJSON_PrintUnformatted(event);
    cJSON_Delete(event);
    if (!json) return false;
    bool ok = false;
    for (unsigned tries = 0; tries < 3; tries++) {
        int code = request("/device/events", HTTP_METHOD_POST, json);
        if (code == 200) {
            cJSON *reply = cJSON_Parse(s_http_reply.data);
            ok = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply, "ok"));
            s_terminal |= cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply, "terminal"));
            cJSON_Delete(reply);
            if (ok) break;
        }
        if (code >= 400 && code < 500 && code != 429) break;
        vTaskDelay(pdMS_TO_TICKS(500 * (tries + 1)));
    }
    free(json);
    return ok;
}

// Runs on the SDK session task. The streaming parser keeps only wanted fields;
// it neither allocates a complete history row nor waits for the HTTPS consumer.
static void on_noise(void *ctx, int status, const uint8_t *data, size_t len, bool end)
{
    uintptr_t token = (uintptr_t)ctx;
    uint32_t gen = (uint32_t)(token >> 1);
    bool ack = (token & 1) != 0;
    lock();
    if (gen != s_generation) { unlock(); return; }
    // Preserve the SDK's frame-size diagnosis even if another stream is then
    // closed with the generic -1 status, or the response queue is already full.
    if (status == NOISE_CTRL_REQ_TOO_LARGE || (status < 0 && !s_noise_failure)) {
        s_noise_failure = status;
    }
    if (ack) {
        if (status) s_ack_status = status;
        if (len >= sizeof(s_ack) - s_ack_len) s_overflow = true;
        else if (len) { memcpy(s_ack + s_ack_len, data, len); s_ack_len += len; s_ack[s_ack_len] = 0; }
        s_ack_done |= end || status < 0;
        unlock();
        return;
    }
    if (status) s_sub_status = status;
    if (s_sub_status == 200 && len) relay_chat_feed(data, len);
    s_sub_done |= end || status < 0;
    unlock();
}

static int64_t open_noise(const char *path, bool ack)
{
    char request_id[48];
    snprintf(request_id, sizeof(request_id), "muse-relay-%08lx-%08lx-%c",
             (unsigned long)s_boot_id, (unsigned long)s_generation, ack ? 'a' : 's');
    const char *headers[] = {"Content-Type", "application/json", "Accept",
        ack ? "application/json" : "application/x-ndjson", "x-app-id", "hatch-web",
        "x-request-id", request_id, NULL};
    return noise_ctrl_req_open("POST", path, headers, false, on_noise,
        (void *)(((uintptr_t)s_generation << 1) | (ack ? 1 : 0)));
}

static void cancel_turn(int64_t note, int64_t sub)
{
    lock(); s_generation++; unlock();
    if (note) noise_ctrl_req_cancel(note);
    if (sub) noise_ctrl_req_cancel(sub);
}

static int64_t subscribe_chat(void)
{
    char body[128];
    snprintf(body, sizeof(body), "{\"session_id\":\"%s\"}", s_active_session);
    lock(); s_sub_done = false; s_sub_status = 0; unlock();
    int64_t id = open_noise("/chat/subscribe", false);
    if (id && !noise_ctrl_req_send(id, body, strlen(body), true, 2000)) {
        noise_ctrl_req_cancel(id);
        return 0;
    }
    return id;
}

static bool valid_id(const char *id)
{
    if (!id || !*id || strlen(id) > 80) return false;
    for (; *id; id++) if (!isalnum((unsigned char)*id) && *id != '-' && *id != '_') return false;
    return true;
}

static bool valid_session(const char *id)
{
    if (!id || !*id || strlen(id) > RELAY_CHAT_ID_BYTES) return false;
    for (; *id; id++) if (!isalnum((unsigned char)*id) && *id != '-') return false;
    return true;
}

static bool bind_ack(void)
{
    cJSON *ack = cJSON_Parse(s_ack);
    cJSON *result = cJSON_GetObjectItemCaseSensitive(ack, "result");
    if (!cJSON_IsObject(result)) result = ack;
    const char *id = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(result, "message_id"));
    const char *parent = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(result, "reply_to_message_id"));
    const char *session = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(result, "session_id"));
    cJSON *error = cJSON_GetObjectItemCaseSensitive(ack, "error");
    cJSON *result_error = cJSON_GetObjectItemCaseSensitive(result, "error");
    bool ok = id && *id && strlen(id) <= RELAY_CHAT_ID_BYTES
        && (!parent || strlen(parent) <= RELAY_CHAT_ID_BYTES)
        && session && !strcmp(session, s_active_session)
        && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(result, "is_thread"))
        && (!error || cJSON_IsNull(error) || cJSON_IsFalse(error))
        && (!result_error || cJSON_IsNull(result_error) || cJSON_IsFalse(result_error));
    if (ok) {
        lock(); relay_chat_bind(id, parent ? parent : "", s_subscription_fresh); unlock();
    }
    cJSON_Delete(ack);
    return ok;
}

static bool post_chat_row(const char *job_id, const relay_chat_event_t *row, bool done)
{
    cJSON *event = cJSON_CreateObject(), *payload = cJSON_CreateObject();
    if (!event || !payload) { cJSON_Delete(event); cJSON_Delete(payload); return false; }
    cJSON_AddStringToObject(event, "type", "event");
    cJSON_AddStringToObject(event, "event", done ? "delta.message_done" : row->event);
    cJSON_AddStringToObject(payload, "message_id", row->id);
    cJSON_AddStringToObject(payload, "session_id", row->session);
    if (row->parent[0]) cJSON_AddStringToObject(payload, "reply_to_message_id", row->parent);
    if (!done && row->text_len) cJSON_AddStringToObject(payload, "text", row->text);
    cJSON_AddItemToObject(event, "payload", payload);
    // Sequence numbers are checked before coalescing by the bounded parser.
    // The device event_id preserves the aggregate's retry idempotence.
    char *body = cJSON_PrintUnformatted(event);
    cJSON_Delete(event);
    if (!body) return false;
    bool ok = post_event(job_id, "muse_event", "body", body);
    free(body);
    return ok;
}

static void run_job(const char *job_id, size_t expected, const char *session)
{
    s_terminal = false;
    s_subscription_fresh = false;
    strcpy(s_active_session, session);
    lock();
    s_generation++; s_overflow = false; s_ack_done = false; s_ack_status = 0; s_ack_len = 0; s_ack[0] = 0;
    s_sub_done = false; s_sub_status = 0;
    s_noise_failure = 0;
    relay_chat_begin(session);
    unlock();
    int64_t note = 0, sub = 0;
    const char *failure = NULL;
    char path[128];
    // Existing chats are subscribed before sending so their own user event
    // cannot be missed. Only an observed 404 proves a new side chat; the
    // official SDK creates that by sending first, then subscribes after ACK.
    sub = subscribe_chat();
    if (!sub) { failure = "muse_subscribe_failed"; goto finish; }
    int64_t subscribe_started = now_ms();
    int subscribe_status = 0;
    bool subscribe_ended = false;
    while (now_ms() - subscribe_started < 15000) {
        lock(); subscribe_status = s_sub_status; subscribe_ended = s_sub_done; unlock();
        if (subscribe_status || !noise_ctrl_is_connected()) break;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (subscribe_status == 404) {
        s_subscription_fresh = true;
        cancel_turn(0, sub); // Invalidate any trailing callback from the 404 stream.
        sub = 0;
        lock(); s_sub_status = 0; s_sub_done = false; unlock();
    } else if (subscribe_status != 200 || subscribe_ended) {
        failure = "muse_subscribe_failed"; goto finish;
    }
    snprintf(path, sizeof(path), "/device/jobs/%s/request", job_id);
    if (!expected || expected > MAX_REQUEST_BYTES || !set_http(path, HTTP_METHOD_GET, NULL)
        || esp_http_client_open(s_http, 0) != ESP_OK) { failure = "request_download_failed"; goto finish; }
    int64_t declared = esp_http_client_fetch_headers(s_http);
    if (esp_http_client_get_status_code(s_http) != 200 || declared != (int64_t)expected) {
        failure = "request_length_mismatch"; goto download_done;
    }
    lock(); relay_chat_start_send(); unlock();
    note = open_noise("/chat/stream", true);
    if (!note) { failure = "muse_not_connected"; goto download_done; }
    size_t total = 0;
    int64_t upload_started = now_ms();
    while (total < expected) {
        uint8_t bytes[CHUNK];
        int n = esp_http_client_read(s_http, (char *)bytes, sizeof(bytes));
        if (n <= 0) { failure = "request_download_interrupted"; break; }
        int64_t queued_at = now_ms();
        if (!noise_ctrl_req_send(note, bytes, (size_t)n, false, 2000)) {
            // Numeric transport diagnostics only: never log request content,
            // credentials, IDs or addresses. Sample before closing HTTP.
            ESP_LOGW(TAG, "upload stopped: sent=%u wait_ms=%u connected=%u dma_free=%u dma_largest=%u heap_largest=%u",
                (unsigned)total, (unsigned)(now_ms() - queued_at), (unsigned)noise_ctrl_is_connected(),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_DMA),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DMA),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
            failure = "muse_upload_interrupted"; break;
        }
        total += (size_t)n;
        if (now_ms() - upload_started > 60000) { failure = "request_upload_timeout"; break; }
    }
download_done:
    // Close the body stream before reusing the one outbound HTTPS connection.
    esp_http_client_close(s_http);
    if (failure) goto finish;
    if (!noise_ctrl_req_send(note, "", 0, true, 2000)) {
        failure = "muse_upload_interrupted"; goto finish;
    }
    bool sent_ack = false;
    int64_t start = now_ms(), heartbeat = start;
    while (!s_terminal && now_ms() - start < TURN_MS) {
        lock();
        bool overflow = s_overflow, ack_done = s_ack_done;
        int ack_status = s_ack_status, noise_failure = s_noise_failure;
        int sub_status = s_sub_status;
        bool sub_done = s_sub_done;
        const char *chat_error = sub ? relay_chat_error() : NULL;
        bool have = sub && !chat_error && relay_chat_take(&s_out_event);
        unlock();
        if (noise_failure == NOISE_CTRL_REQ_TOO_LARGE) { failure = "muse_response_frame_too_large"; break; }
        if (overflow) { failure = "muse_ack_too_large"; break; }
        if (chat_error) { failure = chat_error; break; }
        if (!noise_ctrl_is_connected()) { failure = "muse_connection_lost"; break; }
        if (ack_done && !sent_ack) {
            if (ack_status != 200) { failure = "muse_request_rejected"; break; }
            // ACK is immutable once the callback has marked it complete.
            if (!bind_ack()) { failure = "muse_side_chat_not_acknowledged"; break; }
            if (!post_event(job_id, "muse_ack", "body", s_ack)) { failure = "relay_event_upload_failed"; break; }
            sent_ack = true;
            if (s_terminal) break;
            if (s_subscription_fresh) {
                sub = subscribe_chat();
                if (!sub) { failure = "muse_subscribe_failed"; break; }
            }
        }
        if (sub_status < 0 || sub_status >= 400) { failure = "muse_subscription_failed"; break; }
        if (have) {
            if (!post_chat_row(job_id, &s_out_event, false)
                || (!s_terminal && s_out_event.final && strcmp(s_out_event.event, "delta.message_done")
                    && !post_chat_row(job_id, &s_out_event, true))) {
                failure = "relay_event_upload_failed"; break;
            }
        } else if (sub_done && !s_terminal) {
            failure = "muse_subscription_ended"; break;
        }
        if (!s_terminal && now_ms() - heartbeat >= HEARTBEAT_MS) {
            if (!post_event(job_id, "heartbeat", NULL, NULL)) { failure = "relay_heartbeat_failed"; break; }
            heartbeat = now_ms();
        }
        if (!have) vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!s_terminal && !failure) failure = "muse_response_timeout";
finish:
    // The SDK clears connected before delivering terminal callbacks. Allow
    // that short cross-core teardown to finish before invalidating this turn.
    if (failure && !noise_ctrl_is_connected()) vTaskDelay(pdMS_TO_TICKS(20));
    lock();
    if (failure && s_noise_failure == NOISE_CTRL_REQ_TOO_LARGE) failure = "muse_response_frame_too_large";
    unlock();
    cancel_turn(note, sub);
    if (failure) {
        ESP_LOGW(TAG, "request stopped: %s", failure);
        if (!post_event(job_id, "error", "error", failure)) ESP_LOGW(TAG, "could not report request outcome");
    } else ESP_LOGI(TAG, "request complete");
}

static void relay_task(void *unused)
{
    (void)unused;
    vTaskDelay(pdMS_TO_TICKS(5000)); // SDK owns NVS, Wi-Fi and pairing initialization.
    if (!load_settings()) {
        ESP_LOGI(TAG, "relay is unconfigured; set relay_url and relay_token over USB, then restart");
        vTaskDelete(NULL); return;
    }
    // Give BLE pairing and the initial Muse handshake the RAM first.
    while (!noise_ctrl_is_connected()) vTaskDelay(pdMS_TO_TICKS(2000));
    esp_http_client_config_t config = {
        .url = s_url, .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 8000, .buffer_size = 2048, .buffer_size_tx = 2048,
        .event_handler = on_http, .user_data = &s_http_reply,
        .keep_alive_enable = true, .disable_auto_redirect = true,
    };
    s_http = esp_http_client_init(&config);
    if (!s_http) { ESP_LOGE(TAG, "HTTP client unavailable"); vTaskDelete(NULL); return; }
    for (;;) {
        if (!noise_ctrl_is_connected()) { vTaskDelay(pdMS_TO_TICKS(2000)); continue; }
        int code = request("/device/jobs", HTTP_METHOD_GET, NULL);
        if (code == 200) {
            cJSON *root = cJSON_Parse(s_http_reply.data);
            cJSON *job = cJSON_GetObjectItemCaseSensitive(root, "job");
            const char *id = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(job, "id"));
            const char *session = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(job, "session_id"));
            cJSON *bytes = cJSON_GetObjectItemCaseSensitive(job, "request_bytes");
            if (valid_id(id) && valid_session(session) && cJSON_IsNumber(bytes) && bytes->valuedouble > 0
                && bytes->valuedouble <= MAX_REQUEST_BYTES) {
                char own_id[81]; strcpy(own_id, id);
                char own_session[RELAY_CHAT_ID_BYTES + 1]; strcpy(own_session, session);
                size_t length = (size_t)bytes->valuedouble;
                cJSON_Delete(root);
                run_job(own_id, length, own_session);
            } else cJSON_Delete(root);
        } else if (code == 401 || code == 403) ESP_LOGW(TAG, "relay credential rejected");
        vTaskDelay(pdMS_TO_TICKS(code == 200 ? 2000 : 10000));
    }
}

void __real_app_run(void);
void __wrap_app_run(void)
{
    // Native AtomS3 LCD backlight off; no unused UI/audio allocation.
    gpio_set_direction(GPIO_NUM_16, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_16, 0);
    s_boot_id = esp_random();
    s_lock = xSemaphoreCreateMutex();
    if (s_lock) xTaskCreate(relay_task, "muse_relay", 10240, NULL, 4, NULL);
    else ESP_LOGE(TAG, "relay buffers unavailable");
    __real_app_run();
}
