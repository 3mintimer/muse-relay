// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted for Muse Relay; parser source and changes are described in chat_filter.c.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RELAY_CHAT_TEXT_BYTES 4096
#define RELAY_CHAT_ID_BYTES 80

typedef struct {
    char event[32];
    char id[RELAY_CHAT_ID_BYTES + 1];
    char parent[RELAY_CHAT_ID_BYTES + 1];
    char session[RELAY_CHAT_ID_BYTES + 1];
    size_t text_len;
    bool final; // An append followed by message_done is sent as two events.
    char text[RELAY_CHAT_TEXT_BYTES + 1];
} relay_chat_event_t;

// The caller holds its receive mutex for every call. All storage is bounded;
// feed does not allocate, block, or perform network operations.
void relay_chat_begin(const char *session);
void relay_chat_start_send(void);
void relay_chat_bind(const char *message, const char *parent, bool fresh);
void relay_chat_feed(const uint8_t *data, size_t len);
bool relay_chat_take(relay_chat_event_t *out);
const char *relay_chat_error(void);
