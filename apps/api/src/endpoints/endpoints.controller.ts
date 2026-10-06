import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { EndpointDetail, EndpointSummary } from '@yomail/shared';
import { EndpointsService } from './endpoints.service';

const idPipe = new ParseUUIDPipe({ version: '4' });

@Controller('endpoints')
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  /** No body expected: the id is generated server-side. */
  @Post()
  @HttpCode(201)
  create(): Promise<EndpointSummary> {
    return this.endpoints.create();
  }

  @Get(':id')
  detail(@Param('id', idPipe) id: string): Promise<EndpointDetail> {
    return this.endpoints.detail(id.toLowerCase());
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', idPipe) id: string): Promise<void> {
    return this.endpoints.delete(id.toLowerCase());
  }
}
