import { Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ENDPOINT_ID_REGEX } from '@yomail/shared';
import type { ClientToServerEvents, ServerToClientEvents } from '@yomail/shared';
import { ChangeDetector } from './change-detector.service';
import { LiveEventsService } from './live-events.service';

const ROOM_PREFIX = 'ep:';
const MAX_SUBSCRIPTIONS_PER_SOCKET = 10;

type LiveServer = Server<ClientToServerEvents, ServerToClientEvents>;
type LiveSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Socket.IO gateway. Path, CORS, buffer size and transports come from the adapter
 * configured in main.ts (they depend on API_PREFIX / CORS_ORIGIN). Clients join one
 * room per endpoint (`ep:<id>`); events are pushed from the in-memory bus and from
 * the database ChangeDetector. Under Apache/Passenger the transport is long-polling.
 */
@WebSocketGateway()
export class LiveGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveGateway.name);
  private readonly unsubscribe: Array<() => void> = [];

  @WebSocketServer()
  private readonly server!: LiveServer;

  constructor(
    private readonly events: LiveEventsService,
    private readonly detector: ChangeDetector,
  ) {}

  onModuleInit(): void {
    this.unsubscribe.push(
      this.events.on('request:new', (request) => {
        this.detector.remember(request.id);
        this.server.to(room(request.endpoint_id)).emit('request:new', request);
      }),
      this.events.on('request:deleted', (p) =>
        this.server.to(room(p.endpointId)).emit('request:deleted', p),
      ),
      this.events.on('endpoint:cleared', (p) =>
        this.server.to(room(p.endpointId)).emit('endpoint:cleared', p),
      ),
      this.events.on('endpoint:deleted', (p) =>
        this.server.to(room(p.endpointId)).emit('endpoint:deleted', p),
      ),
    );
    this.detector.start(
      () => this.activeEndpoints(),
      (request) => this.server.to(room(request.endpoint_id)).emit('request:new', request),
    );
  }

  onModuleDestroy(): void {
    this.detector.stop();
    for (const off of this.unsubscribe) off();
  }

  @SubscribeMessage('subscribe')
  subscribe(
    @ConnectedSocket() client: LiveSocket,
    @MessageBody() payload: { endpointId?: string } | undefined,
  ): { ok: boolean; error?: string } {
    const endpointId = payload?.endpointId?.toLowerCase();
    if (!endpointId || !ENDPOINT_ID_REGEX.test(endpointId)) {
      return { ok: false, error: 'invalid endpoint id' };
    }
    const joined = [...client.rooms].filter((r) => r.startsWith(ROOM_PREFIX));
    if (!joined.includes(room(endpointId)) && joined.length >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
      return {
        ok: false,
        error: `at most ${MAX_SUBSCRIPTIONS_PER_SOCKET} subscriptions per connection`,
      };
    }
    this.detector.track(endpointId);
    void client.join(room(endpointId));
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribeEndpoint(
    @ConnectedSocket() client: LiveSocket,
    @MessageBody() payload: { endpointId?: string } | undefined,
  ): { ok: boolean } {
    const endpointId = payload?.endpointId?.toLowerCase();
    if (endpointId) void client.leave(room(endpointId));
    return { ok: true };
  }

  /** Endpoint ids that currently have at least one subscriber on this process. */
  private activeEndpoints(): string[] {
    const ids: string[] = [];
    for (const [name, members] of this.server.sockets.adapter.rooms) {
      if (name.startsWith(ROOM_PREFIX) && members.size > 0)
        ids.push(name.slice(ROOM_PREFIX.length));
    }
    return ids;
  }
}

function room(endpointId: string): string {
  return `${ROOM_PREFIX}${endpointId}`;
}
