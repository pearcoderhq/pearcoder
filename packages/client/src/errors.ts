import { PearcoderError } from '@pearcoderhq/core';

/**
 * Client-side failures. `code` is either a local code (NETWORK, TIMEOUT, HOST_PROOF_INVALID, …)
 * or the error code the host returned.
 */
export class ClientError extends PearcoderError {
  readonly status: number | undefined;
  constructor(code: string, message: string, status?: number, options?: ErrorOptions) {
    super(code, message, options);
    this.status = status;
  }
}
