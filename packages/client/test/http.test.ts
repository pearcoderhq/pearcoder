// Covers: T21 (clients survive a host restart)
import { Agent, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { requestJson } from '../src/http.js';

describe('requestJson', () => {
  const agent = new Agent({ keepAlive: true });
  afterAll(() => agent.destroy());

  it('retries once on a fresh socket when a reused keep-alive socket is reset', async () => {
    // The second request on a connection is dropped, like a pooled socket to a host that restarted.
    const server = createServer((req, res) => {
      const served = (req.socket as unknown as { served?: number }).served ?? 0;
      (req.socket as unknown as { served: number }).served = served + 1;
      if (served >= 1) {
        req.socket.destroy();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const endpoint = { baseUrl, agent };
      expect(await requestJson(endpoint, 'GET', '/v1/health')).toEqual({ ok: true });
      expect(await requestJson(endpoint, 'GET', '/v1/health')).toEqual({ ok: true });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
