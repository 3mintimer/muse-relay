// SPDX-License-Identifier: MIT
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { D_IDLE, D_POLL, D_JOB, D_OTA, D_RECOVERY } diag_phase_t;
void diag_start(const char *url, const char *token, const char *gateway, uint32_t boot);
bool diag_begin_poll(void);
void diag_phase(diag_phase_t phase);
void diag_poll_result(int code, int transport, int tls, bool valid);
bool diag_claim_after_poll(diag_phase_t next);
