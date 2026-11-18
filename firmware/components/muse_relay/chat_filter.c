/* SPDX-License-Identifier: Apache-2.0
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * The incremental parser below is adapted from Muse Gadget SDK
 * esp32/components/muse_apps/muse_apps_chat.c at
 * c3d58c66a02bfea44847e0345714507166656bed (see firmware/SDK-LICENSE).
 * Muse Relay adds session/parent fields, strict turn filtering, and a bounded
 * coalescing outbox. It never buffers entire subscription records: the SDK's
 * opening approvals.snapshot may exceed 17 KiB and contains no reply text.
 */
#include "chat_filter.h"
#include <string.h>

#define CHAT_TEXT_BYTES RELAY_CHAT_TEXT_BYTES

/* What one event or history entry says, as far as the app cares. */
typedef struct {
    char event[32];             /* "event", or "event_name" */
    char type[16];
    char role[16];
    char id[RELAY_CHAT_ID_BYTES + 1];                /* "message_id", else "id" */
    char parent[RELAY_CHAT_ID_BYTES + 1];
    char session[RELAY_CHAT_ID_BYTES + 1];
    char outer_session[RELAY_CHAT_ID_BYTES + 1];
    bool parent_is_reply, metadata_cut;
    char activity[24];          /* "activity_code" */
    char status[24];
    uint64_t seq;
    int ready;                  /* "display_text_ready": -1 when absent */
    bool id_is_message_id;
    int text_rank;              /* 0 none, 1 "text", 2 "content", 3 "display_text" */
    bool text_cut;
    size_t text_len;
    char text[CHAT_TEXT_BYTES + 1];
} chat_row_t;

typedef void (*chat_row_fn)(void *ctx, const chat_row_t *row);

enum {
    K_NONE, K_EVENT, K_TYPE, K_SEQ, K_PAYLOAD, K_ROLE, K_MESSAGE_ID, K_ID,
    K_TEXT, K_CONTENT, K_DISPLAY_TEXT,   /* in rank order */
    K_ACTIVITY, K_STATUS, K_READY, K_CHAT_EVENTS, K_PARENT, K_REPLY_TO, K_SESSION, K_OUTER_SESSION,
};

typedef struct {
    bool lines;                 /* NDJSON: each line a record; else one document with chat_events */
    chat_row_t *row;
    chat_row_fn fn;
    void *ctx;
    int depth;                  /* containers open */
    uint64_t arrays;            /* bit d: the container at depth d (< 64) is an array */
    int record, payload, list;  /* depths of the record, its payload, and chat_events; 0 none */
    bool want_key;              /* the next string is a key */
    int key;                    /* the key whose value comes next */
    bool in_str, str_key;
    int esc;                    /* 0; 1 after a backslash; 2 to 5 in \u's digits */
    uint32_t u, hi;             /* \u's value; a high surrogate waiting for its pair */
    char keybuf[24];
    size_t key_len;
    bool key_long;
    char *dst;                  /* where a wanted string goes, or NULL */
    size_t dst_cap, dst_len;
    bool dst_cut;
    bool in_scalar;
    int scalar_key;
    char scalar[24];
    size_t scalar_len;
} chat_parser_t;

static void chat_parser_init(chat_parser_t *p, bool lines, chat_row_t *row, chat_row_fn fn, void *ctx)
{
    memset(p, 0, sizeof(*p));
    p->lines = lines;
    p->row = row;
    p->fn = fn;
    p->ctx = ctx;
}

/* n, less a last character cut short. */
static size_t utf8_whole(const char *s, size_t n)
{
    if (!n) {
        return 0;
    }
    size_t start = n - 1;
    while (start > 0 && n - start < 4 && ((unsigned char)s[start] & 0xC0) == 0x80) {
        start--;
    }
    unsigned char lead = (unsigned char)s[start];
    size_t need = lead < 0xC0 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
    return n - start < need ? start : n;
}

static bool top_is_object(const chat_parser_t *p)
{
    return p->depth > 0 && p->depth < 64 && !(p->arrays >> p->depth & 1);
}

static int key_id(const chat_parser_t *p)
{
    static const struct {
        const char *name;
        int key;
    } fields[] = {
        {"role", K_ROLE}, {"message_id", K_MESSAGE_ID}, {"id", K_ID}, {"text", K_TEXT},
        {"content", K_CONTENT}, {"display_text", K_DISPLAY_TEXT}, {"activity_code", K_ACTIVITY},
        {"status", K_STATUS}, {"display_text_ready", K_READY},
        {"reply_to_message_id", K_REPLY_TO}, {"parent_message_id", K_PARENT},
        {"session_id", K_SESSION},
    };
    const char *k = p->keybuf;
    if (!p->record) {
        return !p->lines && !strcmp(k, "chat_events") ? K_CHAT_EVENTS : K_NONE;
    }
    bool rec = p->depth == p->record;
    if (rec) {
        if (!strcmp(k, "event") || !strcmp(k, "event_name")) return K_EVENT;
        if (!strcmp(k, "type")) return K_TYPE;
        if (!strcmp(k, "seq")) return K_SEQ;
        if (!strcmp(k, "payload")) return K_PAYLOAD;
        if (!strcmp(k, "session_id")) return K_OUTER_SESSION;
    }
    if (!rec && !(p->payload && p->depth == p->payload)) {
        return K_NONE;
    }
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++) {
        if (!strcmp(k, fields[i].name)) {
            return fields[i].key;
        }
    }
    return K_NONE;
}

static void string_start(chat_parser_t *p)
{
    p->in_str = true;
    p->esc = 0;
    p->hi = 0;
    p->str_key = p->want_key && top_is_object(p);
    p->want_key = false;
    p->dst = NULL;
    p->dst_len = 0;
    p->dst_cut = false;
    if (p->str_key) {
        p->key_len = 0;
        p->key_long = false;
        return;
    }
    chat_row_t *r = p->row;
    switch (p->key) {
    case K_EVENT: p->dst = r->event; p->dst_cap = sizeof(r->event) - 1; break;
    case K_TYPE: p->dst = r->type; p->dst_cap = sizeof(r->type) - 1; break;
    case K_ROLE: p->dst = r->role; p->dst_cap = sizeof(r->role) - 1; break;
    case K_ACTIVITY: p->dst = r->activity; p->dst_cap = sizeof(r->activity) - 1; break;
    case K_STATUS: p->dst = r->status; p->dst_cap = sizeof(r->status) - 1; break;
    case K_MESSAGE_ID:
        r->id_is_message_id = true;
        p->dst = r->id;
        p->dst_cap = sizeof(r->id) - 1;
        break;
    case K_ID:
        if (!r->id_is_message_id) {
            p->dst = r->id;
            p->dst_cap = sizeof(r->id) - 1;
        }
        break;
    case K_REPLY_TO:
        r->parent_is_reply = true;
        p->dst = r->parent;
        p->dst_cap = sizeof(r->parent) - 1;
        break;
    case K_PARENT:
        if (!r->parent_is_reply) {
            p->dst = r->parent;
            p->dst_cap = sizeof(r->parent) - 1;
        }
        break;
    case K_SESSION: p->dst = r->session; p->dst_cap = sizeof(r->session) - 1; break;
    case K_OUTER_SESSION: p->dst = r->outer_session; p->dst_cap = sizeof(r->outer_session) - 1; break;
    case K_TEXT:
    case K_CONTENT:
    case K_DISPLAY_TEXT:
        if (p->key - K_TEXT + 1 >= r->text_rank) {
            r->text_rank = p->key - K_TEXT + 1;
            r->text_len = 0;
            r->text_cut = false;
            p->dst = r->text;
            p->dst_cap = CHAT_TEXT_BYTES;
        }
        break;
    default: break;
    }
}

static void string_out(chat_parser_t *p, const char *b, size_t n)
{
    if (p->str_key) {
        if (p->key_len + n >= sizeof(p->keybuf)) {
            p->key_long = true;
        } else {
            memcpy(p->keybuf + p->key_len, b, n);
            p->key_len += n;
        }
    } else if (p->dst && !p->dst_cut) {
        if (p->dst_len + n > p->dst_cap) {
            p->dst_cut = true;
        } else {
            memcpy(p->dst + p->dst_len, b, n);
            p->dst_len += n;
        }
    }
}

static void string_code(chat_parser_t *p, uint32_t c)
{
    char b[4];
    size_t n;
    if (c == '\n') {
        string_out(p, "\n", 1);
        return;
    }
    if (c == '\t') {
        c = ' ';
    }
    if (c < 0x20) {
        return;   /* other control characters show as nothing */
    }
    if (c < 0x80) {
        b[0] = (char)c;
        n = 1;
    } else if (c < 0x800) {
        b[0] = (char)(0xC0 | c >> 6);
        b[1] = (char)(0x80 | (c & 63));
        n = 2;
    } else if (c < 0x10000) {
        b[0] = (char)(0xE0 | c >> 12);
        b[1] = (char)(0x80 | (c >> 6 & 63));
        b[2] = (char)(0x80 | (c & 63));
        n = 3;
    } else {
        b[0] = (char)(0xF0 | c >> 18);
        b[1] = (char)(0x80 | (c >> 12 & 63));
        b[2] = (char)(0x80 | (c >> 6 & 63));
        b[3] = (char)(0x80 | (c & 63));
        n = 4;
    }
    string_out(p, b, n);
}

static void string_end(chat_parser_t *p)
{
    p->in_str = false;
    if (p->str_key) {
        p->keybuf[p->key_len] = '\0';
        p->key = p->key_long ? K_NONE : key_id(p);
        return;
    }
    if (p->dst) {
        if (p->dst_cut) {
            p->dst_len = utf8_whole(p->dst, p->dst_len);
        }
        p->dst[p->dst_len] = '\0';
        if (p->dst != p->row->text && p->dst_cut) p->row->metadata_cut = true;
        if (p->dst == p->row->text) {
            p->row->text_len = p->dst_len;
            p->row->text_cut = p->dst_cut;
        }
        p->dst = NULL;
    }
    p->key = K_NONE;
}

static int hex_value(unsigned char c)
{
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

static void string_char(chat_parser_t *p, char ch)
{
    unsigned char c = (unsigned char)ch;
    if (p->esc == 1) {
        p->esc = 0;
        if (c == 'u') {
            p->esc = 2;
            p->u = 0;
            return;   /* a high surrogate may still wait for this one */
        }
        p->hi = 0;
        if (c == 'n') {
            string_out(p, "\n", 1);
        } else if (c == 't') {
            string_out(p, " ", 1);
        } else if (c != 'r' && c != 'b' && c != 'f') {
            string_out(p, &ch, 1);   /* \" \\ \/ */
        }
        return;
    }
    if (p->esc >= 2) {
        int v = hex_value(c);
        if (v < 0) {
            p->esc = 0;
            p->hi = 0;
            return;
        }
        p->u = p->u << 4 | (uint32_t)v;
        if (++p->esc < 6) {
            return;
        }
        p->esc = 0;
        uint32_t u = p->u;
        if (u >= 0xD800 && u < 0xDC00) {
            p->hi = u;
        } else if (u >= 0xDC00 && u < 0xE000) {
            if (p->hi) {
                string_code(p, 0x10000 + ((p->hi - 0xD800) << 10) + (u - 0xDC00));
            }
            p->hi = 0;
        } else {
            p->hi = 0;
            string_code(p, u);
        }
        return;
    }
    if (c == '\\') {
        p->esc = 1;
        return;
    }
    p->hi = 0;
    if (c == '"') {
        string_end(p);
    } else if (c >= 0x20) {
        string_out(p, &ch, 1);
    }
}

static void scalar_end(chat_parser_t *p)
{
    p->in_scalar = false;
    p->scalar[p->scalar_len] = '\0';
    if (p->scalar_key == K_SEQ) {
        uint64_t v = 0;
        for (const char *s = p->scalar; *s >= '0' && *s <= '9'; s++) {
            v = v * 10 + (uint64_t)(*s - '0');
        }
        p->row->seq = v;
    } else if (p->scalar_key == K_READY) {
        p->row->ready = p->scalar[0] == 't';
    }
    p->key = K_NONE;
}

static void open_container(chat_parser_t *p, bool array)
{
    int key = p->key;
    p->key = K_NONE;
    p->depth++;
    if (p->depth < 64) {
        if (array) {
            p->arrays |= 1ull << p->depth;
        } else {
            p->arrays &= ~(1ull << p->depth);
        }
    }
    p->want_key = !array;
    if (array) {
        if (key == K_CHAT_EVENTS && !p->list) {
            p->list = p->depth;
        }
    } else if (!p->record && (p->lines ? p->depth == 1 : p->list && p->depth == p->list + 1)) {
        p->record = p->depth;
        chat_row_t *r = p->row;
        memset(r, 0, offsetof(chat_row_t, text));
        r->text[0] = '\0';
        r->ready = -1;
    } else if (p->record && key == K_PAYLOAD && p->depth == p->record + 1) {
        p->payload = p->depth;
    }
}

static void close_container(chat_parser_t *p)
{
    if (p->depth <= 0) {
        return;
    }
    if (p->record && p->depth == p->record) {
        p->record = p->payload = 0;
        if (p->fn) {
            p->fn(p->ctx, p->row);
        }
    } else if (p->payload && p->depth == p->payload) {
        p->payload = 0;
    } else if (p->list && p->depth == p->list) {
        p->list = 0;
    }
    p->depth--;
    p->want_key = false;
    p->key = K_NONE;
}

/* Feeds the next bytes, in any pieces: a line may span frames. */
static void chat_parse(chat_parser_t *p, const char *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        char c = data[i];
        if (p->lines && c == '\n') {   /* a line ends: whatever is half read goes */
            chat_parser_init(p, p->lines, p->row, p->fn, p->ctx);
            continue;
        }
        if (p->in_str) {
            string_char(p, c);
            continue;
        }
        if (p->in_scalar) {
            if (c != ',' && c != '}' && c != ']' && c != ' ' && c != '\t' && c != '\r' && c != '\n') {
                if (p->scalar_len < sizeof(p->scalar) - 1) {
                    p->scalar[p->scalar_len++] = c;
                }
                continue;
            }
            scalar_end(p);
        }
        switch (c) {
        case '{': open_container(p, false); break;
        case '[': open_container(p, true); break;
        case '}':
        case ']': close_container(p); break;
        case ',':
            p->key = K_NONE;
            p->want_key = top_is_object(p);
            break;
        case '"': string_start(p); break;
        case ':':
        case ' ':
        case '\t':
        case '\r':
        case '\n': break;
        default:
            p->in_scalar = true;
            p->scalar_key = p->key;
            p->scalar[0] = c;
            p->scalar_len = 1;
            break;
        }
    }
}

// Only one request runs at a time. Keep its transcript and one assistant
// outbox, coalescing append events while the HTTPS consumer is busy.
static chat_parser_t s_parser;
static chat_row_t s_row;
static relay_chat_event_t s_user, s_reply;
static bool s_have_user, s_have_reply, s_after_note, s_completed;
static bool s_collect, s_acknowledged, s_rejected_overflow;
static char s_session[RELAY_CHAT_ID_BYTES + 1];
static char s_message[RELAY_CHAT_ID_BYTES + 1], s_parent[RELAY_CHAT_ID_BYTES + 1];
static char s_reply_id[RELAY_CHAT_ID_BYTES + 1];
static char s_provisional_user[RELAY_CHAT_ID_BYTES + 1];
static char s_rejected[8][RELAY_CHAT_ID_BYTES + 1];
static size_t s_rejected_count, s_reply_bytes;
static uint64_t s_row_seq, s_live_seq;
static const char *s_error;
static const char *s_provisional_error;

static bool own_id(const char *id)
{
    return id[0] && (!strcmp(id, s_message) || (s_parent[0] && !strcmp(id, s_parent)));
}

static bool rejected(const char *id)
{
    for (size_t i = 0; i < s_rejected_count; i++) {
        if (!strcmp(id, s_rejected[i])) return true;
    }
    return false;
}

static void reject_id(const char *id)
{
    if (rejected(id)) return;
    if (s_rejected_count == sizeof(s_rejected) / sizeof(s_rejected[0])) {
        // Keep explicit parents authoritative even after our small rejection
        // list fills: later parentless traffic is no longer admitted by order.
        s_rejected_overflow = true;
        return;
    }
    strcpy(s_rejected[s_rejected_count++], id);
}

static void copy_row(relay_chat_event_t *out, const chat_row_t *row)
{
    memset(out, 0, sizeof(*out));
    strcpy(out->event, row->event);
    strcpy(out->id, row->id);
    strcpy(out->parent, row->parent);
    strcpy(out->session, s_session);
    out->text_len = row->text_len;
    memcpy(out->text, row->text, row->text_len + 1);
}

static void take_row(void *unused, const chat_row_t *row)
{
    (void)unused;
    if (!s_collect || s_error || (s_completed && s_acknowledged)
        || row->metadata_cut || strcmp(row->type, "event") || !row->id[0]) return;
    if ((row->session[0] && strcmp(row->session, s_session))
        || (row->outer_session[0] && strcmp(row->outer_session, s_session))) return;
    bool user = !strcmp(row->event, "message.user");
    bool full = !strcmp(row->event, "message.assistant");
    bool start = !strcmp(row->event, "delta.message_start");
    bool append = !strcmp(row->event, "delta.text_append");
    bool done = !strcmp(row->event, "delta.message_done");
    if (!user && !full && !start && !append && !done) return;
    uint64_t *last = user || full ? &s_row_seq : &s_live_seq;
    if (row->seq && row->seq <= *last) return;
    if (user) {
        if (!s_acknowledged) {
            // Before the ACK, retain only the latest user boundary and its
            // bounded reply candidate. The ACK will prove or discard both.
            copy_row(&s_user, row);
            s_have_user = true;
            s_have_reply = s_completed = false;
            s_reply_id[0] = 0;
            strcpy(s_provisional_user, row->id);
            s_reply_bytes = 0;
            s_live_seq = 0;
            s_provisional_error = row->text_cut ? "muse_response_text_too_large" : NULL;
            if (row->seq) *last = row->seq;
            return;
        }
        s_after_note = own_id(row->id);
        if (!s_after_note) return;
        if (row->text_cut) { s_error = "muse_response_text_too_large"; return; }
        if (row->seq) *last = row->seq;
        copy_row(&s_user, row);
        s_have_user = true;
        return;
    }
    bool parent_matches = own_id(row->parent);
    if (s_acknowledged) {
        if (row->parent[0] && !parent_matches) { reject_id(row->id); return; }
        if (rejected(row->id) || (!parent_matches
            && !(s_after_note && !s_rejected_overflow) && strcmp(row->id, s_reply_id))) return;
    } else {
        if (!s_provisional_user[0] && !row->parent[0]) return;
        if (row->parent[0] && s_provisional_user[0] && strcmp(row->parent, s_provisional_user)) return;
        if (s_reply_id[0] && strcmp(s_reply_id, row->id)) {
            // A provisional earlier reply must not make a later own turn fail.
            s_have_reply = s_completed = false;
            s_reply_bytes = 0;
            s_provisional_error = NULL;
        } else if (s_completed) return;
    }
    if (row->seq) *last = row->seq;
    if (s_acknowledged && row->text_cut) { s_error = "muse_response_text_too_large"; return; }
    if (s_acknowledged && s_reply_id[0] && strcmp(s_reply_id, row->id)) {
        s_error = "muse_response_buffer_full";
        return;
    }
    strcpy(s_reply_id, row->id);
    if (!s_acknowledged && row->text_cut) s_provisional_error = "muse_response_text_too_large";
    if (start) {
        if (!s_have_reply) { copy_row(&s_reply, row); s_have_reply = true; }
        return;
    }
    if (full && row->ready == 0) return;
    if (append) {
        if (row->text_len > RELAY_CHAT_TEXT_BYTES - s_reply_bytes) {
            if (s_acknowledged) s_error = "muse_response_text_too_large";
            else s_provisional_error = "muse_response_text_too_large";
            return;
        }
        s_reply_bytes += row->text_len;
        if (!s_have_reply) {
            copy_row(&s_reply, row);
            s_have_reply = true;
        } else {
            // The total-reply bound also bounds the unsent append outbox.
            strcpy(s_reply.event, "delta.text_append");
            memcpy(s_reply.text + s_reply.text_len, row->text, row->text_len + 1);
            s_reply.text_len += row->text_len;
            if (row->parent[0]) strcpy(s_reply.parent, row->parent);
        }
        return;
    }
    if (full || (done && row->text_len)) {
        copy_row(&s_reply, row); // A complete row replaces its earlier deltas.
        s_reply_bytes = row->text_len;
        s_have_reply = true;
    } else if (done) {
        if (!s_have_reply) { copy_row(&s_reply, row); s_have_reply = true; }
        s_reply.final = true; // Flush remaining appends before the done event.
    }
    s_completed = full || done;
}

void relay_chat_begin(const char *session)
{
    memset(&s_user, 0, sizeof(s_user));
    memset(&s_reply, 0, sizeof(s_reply));
    memset(s_rejected, 0, sizeof(s_rejected));
    s_have_user = s_have_reply = s_after_note = s_completed = false;
    s_collect = s_acknowledged = s_rejected_overflow = false;
    s_reply_id[0] = 0;
    s_message[0] = s_parent[0] = s_provisional_user[0] = 0;
    s_rejected_count = s_reply_bytes = 0;
    s_row_seq = s_live_seq = 0;
    s_error = s_provisional_error = NULL;
    strcpy(s_session, session);
    chat_parser_init(&s_parser, true, &s_row, take_row, NULL);
}

void relay_chat_start_send(void)
{
    // Keep the incremental parser at its current byte boundary; an irrelevant
    // opening snapshot may still be arriving while the request starts.
    s_collect = true;
}

void relay_chat_bind(const char *message, const char *parent, bool fresh)
{
    strcpy(s_message, message);
    strcpy(s_parent, parent);
    s_acknowledged = true;
    bool own_user = s_have_user && own_id(s_user.id);
    s_after_note = fresh || own_user;
    if (!own_user) { s_have_user = false; s_row_seq = 0; }
    bool own_reply = s_have_reply && (own_id(s_reply.parent) || own_id(s_provisional_user));
    if (!own_reply) {
        s_have_reply = s_completed = false;
        s_reply_id[0] = 0;
        s_live_seq = s_reply_bytes = 0;
    }
    if ((own_user || own_reply) && s_provisional_error) s_error = s_provisional_error;
}

void relay_chat_feed(const uint8_t *data, size_t len)
{
    chat_parse(&s_parser, (const char *)data, len);
}

bool relay_chat_take(relay_chat_event_t *out)
{
    if (!s_acknowledged) return false;
    if (s_have_user) { *out = s_user; s_have_user = false; return true; }
    if (s_have_reply) { *out = s_reply; s_have_reply = false; return true; }
    return false;
}

const char *relay_chat_error(void) { return s_error; }
