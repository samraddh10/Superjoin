/**
 * API entry point.
 *
 * Binds to 0.0.0.0 because the process runs in a container and must accept connections
 * from outside it; on the host that is equivalent to localhost.
 */

import { buildServer } from './server.ts';

const server = await buildServer();

/**
 * Closes the pool and stops accepting connections before exiting.
 *
 * Compose sends SIGTERM on `down` and on a restart. Without this the process is killed
 * after the grace period with connections still open, which shows up later as confusing
 * connection-limit errors rather than as a shutdown problem.
 */
async function shutdown(signal: string): Promise<void> {
  server.app.log.info({ signal }, 'shutting down');
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    server.app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await server.app.listen({ host: '0.0.0.0', port: server.config.port });
} catch (error) {
  server.app.log.error({ err: error }, 'failed to start');
  await server.close();
  process.exit(1);
}
