/**
 * What went wrong, as a stable string you can switch on. The message says what to do next.
 *
 * - `CONNECTION_FAILED`: the TCP (or custom stream) connection could not be opened
 * - `CONNECTION_CLOSED`: the server or the network closed the connection
 * - `TIMEOUT`: the handshake did not finish within `timeout`
 * - `ABORTED`: the `signal` was aborted
 * - `NOT_RFB`: the peer did not answer with an RFB version string
 * - `UNSUPPORTED_VERSION`: the server speaks a protocol version this client can't
 * - `SERVER_REFUSED`: the server refused the connection and said why (`reason`)
 * - `UNSUPPORTED_SECURITY`: no security type in common with the server
 * - `AUTH_REQUIRED`: the server wants credentials and none were given
 * - `AUTH_FAILED`: the server rejected the credentials (`reason` when it said why)
 * - `TLS_FAILED`: the TLS handshake of a VeNCrypt security type failed
 * - `UNSUPPORTED_ENCODING`: an encoding this client can't decode was requested or received
 * - `UNSUPPORTED_MESSAGE`: the server sent a message type this client doesn't know
 * - `UNSUPPORTED_BY_SERVER`: a method needs an extension the server hasn't confirmed (see `client.supports`)
 * - `PROTOCOL_ERROR`: malformed data on the wire
 * - `INVALID_ARGUMENT`: a bad option or method argument
 * - `CLIPBOARD_TOO_LARGE`: (a `warning`, the connection goes on) the server's clipboard text was over
 *   `maxClipboardBytes` and was dropped
 */
export type RfbErrorCode =
  | 'CONNECTION_FAILED'
  | 'CONNECTION_CLOSED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NOT_RFB'
  | 'UNSUPPORTED_VERSION'
  | 'SERVER_REFUSED'
  | 'UNSUPPORTED_SECURITY'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'TLS_FAILED'
  | 'UNSUPPORTED_ENCODING'
  | 'UNSUPPORTED_MESSAGE'
  | 'UNSUPPORTED_BY_SERVER'
  | 'PROTOCOL_ERROR'
  | 'INVALID_ARGUMENT'
  | 'CLIPBOARD_TOO_LARGE'

export interface RfbErrorOptions {
  cause?: unknown
  /** The server's own explanation, when it sent one. */
  reason?: string
}

export class RfbError extends Error {
  readonly code: RfbErrorCode
  /** The server's own explanation, when it sent one. */
  readonly reason?: string

  constructor(code: RfbErrorCode, message: string, options: RfbErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RfbError'
    this.code = code
    if (options.reason !== undefined) this.reason = options.reason
  }
}

export function protocolError(message: string): RfbError {
  return new RfbError('PROTOCOL_ERROR', message)
}
