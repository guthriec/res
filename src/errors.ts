export const ErrorCodes = {
  CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
  CONTENT_NOT_FOUND: "CONTENT_NOT_FOUND",
  CONTENT_FILE_NOT_FOUND: "CONTENT_FILE_NOT_FOUND",
  UNABLE_TO_RESOLVE_FILE_PATH: "UNABLE_TO_RESOLVE_FILE_PATH",
  RESERVOIR_NOT_FOUND: "RESERVOIR_NOT_FOUND",
  FETCHER_NOT_FOUND: "FETCHER_NOT_FOUND",
  FETCHER_ALREADY_EXISTS: "FETCHER_ALREADY_EXISTS",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_RANGE: "INVALID_RANGE",
  ID_NOT_FOUND: "ID_NOT_FOUND",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
  FETCH_FAILED: "FETCH_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ReservoirError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ReservoirError";
    this.code = code;
  }
}
