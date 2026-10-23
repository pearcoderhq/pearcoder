import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPearcoderMcpServer, type PearcoderMcpOptions } from './server.js';

/**
 * Serves MCP over stdin/stdout until the client disconnects or `signal` aborts. stdout carries
 * the protocol, so nothing else may be written to it while this runs.
 */
export async function runStdioServer(
  options: PearcoderMcpOptions,
  signal: AbortSignal,
): Promise<void> {
  const server = createPearcoderMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
