import { Global, Module } from '@nestjs/common';
import { LiveEventsService } from './live-events.service';

/**
 * Global so capture, requests and endpoints can emit without each importing a
 * module that would in turn depend on them (the gateway lives in LiveModule).
 */
@Global()
@Module({
  providers: [LiveEventsService],
  exports: [LiveEventsService],
})
export class LiveEventsModule {}
