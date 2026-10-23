// Errors carry a stable `code` for callers and network responses. Messages may contain local
// detail (paths) and must not be sent over the network as-is (docs/invariants.md, engineering rules).
export class PearcoderError<Code extends string = string> extends Error {
  readonly code: Code;

  constructor(code: Code, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
