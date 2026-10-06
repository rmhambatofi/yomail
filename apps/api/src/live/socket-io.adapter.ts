import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO server options that depend on the environment (API_PREFIX, CORS_ORIGIN)
 * cannot go in the @WebSocketGateway decorator, which is evaluated before the .env
 * is loaded. The adapter merges them in when Nest creates the server.
 * Transports stay at the default ['polling', 'websocket']: under Apache/Passenger the
 * upgrade to WebSocket fails and long-polling is what actually runs in production.
 */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly overrides: Partial<ServerOptions>,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, { ...options, ...this.overrides } as ServerOptions);
  }
}

/** `/api/socket.io` with the default prefix, `/socket.io` when API_PREFIX is empty. */
export function socketIoPath(apiPrefix: string): string {
  const prefix = apiPrefix.replace(/^\/+|\/+$/g, '');
  return prefix ? `/${prefix}/socket.io` : '/socket.io';
}
