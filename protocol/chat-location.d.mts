import type { ChatLocation } from '../src/core/types';

export function chatLocation(request: { kind: string; location?: unknown }): ChatLocation | undefined;
