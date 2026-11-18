// SPDX-License-Identifier: MIT
// Small host regression check for the burst seen on the physical device.
// cc -std=c11 -Wall -Wextra -Werror -Ifirmware/components/muse_relay \
//   firmware/tools/check_chat_filter.c firmware/components/muse_relay/chat_filter.c -o /tmp/check-chat-filter
#include "chat_filter.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static relay_chat_event_t out;
static void feed(const char *s)
{
    // Deliberately split keys, escape sequences and multibyte text.
    size_t len = strlen(s);
    for (size_t i = 0; i < len; i += 7) {
        size_t n = len - i < 7 ? len - i : 7;
        relay_chat_feed((const uint8_t *)s + i, n);
    }
}
static void begin(void)
{
    relay_chat_begin("relay-session");
    relay_chat_start_send();
    relay_chat_bind("note-1", "", false);
}
static void user(void)
{
    feed("{\"type\":\"event\",\"event\":\"message.user\",\"seq\":2,\"payload\":{\"message_id\":\"note-1\",\"session_id\":\"relay-session\",\"text\":\"hi\"}}\n");
}

int main(void)
{
    begin();
    feed("{\"type\":\"event\",\"event\":\"approvals.snapshot\",\"payload\":{\"items\":[{\"detail\":\"");
    char block[1025]; memset(block, 'x', sizeof(block) - 1); block[1024] = 0;
    for (int i = 0; i < 256; i++) feed(block);
    feed("\"}]}}\n");
    // A huge unrelated row with identifying fields AFTER its text is skipped.
    feed("{\"type\":\"event\",\"event\":\"message.assistant\",\"seq\":999999,\"payload\":{\"text\":\"");
    for (int i = 0; i < 32; i++) feed(block);
    feed("\",\"message_id\":\"old-reply\",\"reply_to_message_id\":\"old-note\"}}\n");
    assert(!relay_chat_error() && !relay_chat_take(&out));
    user();
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"seq\":100,\"payload\":{\"message_id\":\"reply-1\",\"text\":\"日本\"}}\n");
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"seq\":101,\"payload\":{\"message_id\":\"reply-1\",\"text\":\"語\\ud83d\\ude00\"}}\n");
    // Duplicate live sequence must not append twice.
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"seq\":101,\"payload\":{\"message_id\":\"reply-1\",\"text\":\"bad\"}}\n");
    feed("{\"type\":\"event\",\"event\":\"delta.message_done\",\"seq\":102,\"payload\":{\"message_id\":\"reply-1\"}}\n");
    assert(relay_chat_take(&out) && !strcmp(out.event, "message.user"));
    assert(relay_chat_take(&out) && !strcmp(out.text, "日本語😀") && out.final);
    assert(!relay_chat_error() && !relay_chat_take(&out));

    begin();
    // Either explicit session field can reject a row; neither is overwritten.
    feed("{\"type\":\"event\",\"event\":\"message.user\",\"session_id\":\"foreign\",\"payload\":{\"session_id\":\"relay-session\",\"message_id\":\"note-1\"}}\n");
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"payload\":{\"message_id\":\"reply-1\",\"text\":\"not admitted\"}}\n");
    assert(!relay_chat_take(&out));
    user(); assert(relay_chat_take(&out));
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"seq\":999999,\"payload\":{\"message_id\":\"foreign\",\"reply_to_message_id\":\"other-note\",\"text\":\"wrong\"}}\n");
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"seq\":100,\"payload\":{\"message_id\":\"reply-1\",\"text\":\"part\"}}\n");
    // Message rows and live deltas have separate sequence domains.
    feed("{\"type\":\"event\",\"event\":\"message.assistant\",\"seq\":3,\"payload\":{\"message_id\":\"reply-1\",\"display_text\":\"complete\"}}\n");
    assert(relay_chat_take(&out) && !strcmp(out.event, "message.assistant") && !strcmp(out.text, "complete"));
    assert(!relay_chat_error());

    begin(); user(); assert(relay_chat_take(&out));
    feed("{\"type\":\"event\",\"event\":\"message.user\",\"seq\":3,\"payload\":{\"message_id\":\"someone-else\"}}\n");
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"payload\":{\"message_id\":\"other-reply\",\"text\":\"wrong\"}}\n");
    assert(!relay_chat_take(&out) && !relay_chat_error());

    begin(); user(); assert(relay_chat_take(&out));
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"payload\":{\"message_id\":\"reply-1\",\"text\":\"");
    for (int i = 0; i < 4; i++) feed(block);
    feed("\"}}\n");
    assert(relay_chat_take(&out) && out.text_len == RELAY_CHAT_TEXT_BYTES);
    // Draining the outbox must not reset the whole-response size bound.
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"payload\":{\"message_id\":\"reply-1\",\"text\":\"x\"}}\n");
    assert(relay_chat_error() && !strcmp(relay_chat_error(), "muse_response_text_too_large"));
    relay_chat_begin("relay-session");
    relay_chat_start_send();
    user();
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"seq\":10,\"payload\":{\"message_id\":\"reply-1\",\"text\":\"before ACK\"}}\n");
    feed("{\"type\":\"event\",\"event\":\"delta.message_done\",\"seq\":11,\"payload\":{\"message_id\":\"reply-1\"}}\n");
    assert(!relay_chat_take(&out));
    relay_chat_bind("note-1", "", false);
    assert(relay_chat_take(&out) && !strcmp(out.event, "message.user"));
    assert(relay_chat_take(&out) && out.final && !strcmp(out.text, "before ACK"));
    assert(!relay_chat_error());

    relay_chat_begin("relay-session");
    relay_chat_start_send();
    user();
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"payload\":{\"message_id\":\"reply-1\",\"text\":\"other request\"}}\n");
    relay_chat_bind("different-note", "", false);
    assert(!relay_chat_take(&out) && !relay_chat_error());

    relay_chat_begin("relay-session");
    relay_chat_start_send();
    relay_chat_bind("note-1", "", true); // Caller proved subscribe 404 and ACK side chat.
    feed("{\"type\":\"event\",\"event\":\"delta.text_append\",\"payload\":{\"message_id\":\"reply-1\",\"text\":\"fresh side chat\"}}\n");
    assert(relay_chat_take(&out) && !strcmp(out.text, "fresh side chat"));
    puts("chat filter: burst, scope, sequence, UTF-8, size and pre-ACK checks passed");
    return 0;
}
