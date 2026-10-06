import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { RequestSummary, ServerToClientEvents } from '@yomail/shared';

type EventName = keyof ServerToClientEvents;
type Payload<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

/**
 * In-process event bus between the services that change data (capture, requests,
 * endpoints) and the Socket.IO gateway. It only reaches sockets connected to THIS
 * process; the gateway's ChangeDetector covers the other Passenger processes by
 * polling the database, so `request:new` may arrive twice and clients dedupe by id.
 */
@Injectable()
export class LiveEventsService {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  requestNew(request: RequestSummary): void {
    this.emit('request:new', request);
  }

  requestDeleted(endpointId: string, id: string): void {
    this.emit('request:deleted', { endpointId, id });
  }

  endpointCleared(endpointId: string): void {
    this.emit('endpoint:cleared', { endpointId });
  }

  endpointDeleted(endpointId: string): void {
    this.emit('endpoint:deleted', { endpointId });
  }

  on<E extends EventName>(event: E, listener: (payload: Payload<E>) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  private emit<E extends EventName>(event: E, payload: Payload<E>): void {
    this.emitter.emit(event, payload);
  }
}
