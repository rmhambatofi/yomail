import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import type { RequestDetail, RequestListResponse } from '@yomail/shared';
import { ParseIsoDatePipe } from './parse-iso-date.pipe';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, RequestsService } from './requests.service';

const endpointIdPipe = new ParseUUIDPipe({ version: '4' });
const requestIdPipe = new ParseUUIDPipe({ version: '4' });

@Controller('endpoints/:endpointId/requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  list(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Query('limit', new DefaultValuePipe(LIST_DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('before', ParseIsoDatePipe) before: Date | null,
  ): Promise<RequestListResponse> {
    if (limit < 1 || limit > LIST_MAX_LIMIT) {
      throw new BadRequestException(`limit must be between 1 and ${LIST_MAX_LIMIT}`);
    }
    return this.requests.list(endpointId.toLowerCase(), { limit, before });
  }

  @Get(':id')
  detail(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Param('id', requestIdPipe) id: string,
  ): Promise<RequestDetail> {
    return this.requests.detail(endpointId.toLowerCase(), id.toLowerCase());
  }

  @Delete(':id')
  @HttpCode(204)
  delete(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Param('id', requestIdPipe) id: string,
  ): Promise<void> {
    return this.requests.delete(endpointId.toLowerCase(), id.toLowerCase());
  }

  @Delete()
  @HttpCode(204)
  clear(@Param('endpointId', endpointIdPipe) endpointId: string): Promise<void> {
    return this.requests.clear(endpointId.toLowerCase());
  }
}
