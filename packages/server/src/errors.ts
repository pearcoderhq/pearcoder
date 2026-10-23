import { EventRejectedError, InvitationError, PearcoderError } from '@pearcoderhq/core';

export interface ErrorBody {
  error: { code: string; message: string };
}

const EVENT_STATUS: Record<string, number> = {
  INVALID_EVENT: 400,
  INVALID_PAYLOAD: 400,
  UNSUPPORTED_VERSION: 400,
  WRONG_SESSION: 400,
  INVALID_JOIN: 400,
  EVENT_TOO_LARGE: 413,
  BAD_SIGNATURE: 403,
  UNKNOWN_PARTICIPANT: 403,
  FORBIDDEN_FOR_ROLE: 403,
  EVENT_ID_CONFLICT: 409,
  RATE_LIMITED: 429,
};

export class HttpError extends PearcoderError {
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(code, message);
    this.status = status;
  }
}

/**
 * Maps known errors to a status and a safe body. Rejection messages from core describe the
 * request, not the host; anything unexpected becomes a generic 500 (docs/invariants.md, engineering rules).
 */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof EventRejectedError) {
    return {
      status: EVENT_STATUS[error.code] ?? 400,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof InvitationError) {
    return {
      status: error.code === 'INVITE_MALFORMED' ? 400 : 403,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'internal error' } } };
}
