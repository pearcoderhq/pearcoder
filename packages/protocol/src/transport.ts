// WebSocket subprotocols for the session stream. Browsers cannot send headers on WebSockets, so
// the bearer token travels as the second subprotocol: [WS_PROTOCOL, WS_AUTH_PREFIX + token].
export const WS_PROTOCOL = 'pearcoder.v1';
export const WS_AUTH_PREFIX = 'pearcoder.auth.';
