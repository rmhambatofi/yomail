import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { ReplayResult, RequestDetail, RequestListResponse } from '@yomail/shared';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { User } from '../users/user.entity';
import { ParseIsoDatePipe } from './parse-iso-date.pipe';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, RequestsService } from './requests.service';
import { replaySchema, updateNoteSchema } from './schemas';
import type { ReplayBody, UpdateNoteBody } from './schemas';

const endpointIdPipe = new ParseUUIDPipe({ version: '4' });
const requestIdPipe = new ParseUUIDPipe({ version: '4' });

/** Replays per IP and per minute (per process). */
const REPLAY_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@Controller('endpoints/:endpointId/requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  /**
   * The inbox of an ownerless endpoint is open to whoever knows the UUID; an owned
   * endpoint is private to its owner (401 / 403 NOT_OWNER). Same rule for every route below.
   */
  @Get()
  @UseGuards(OptionalAuthGuard)
  list(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Query('limit', new DefaultValuePipe(LIST_DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('before', ParseIsoDatePipe) before: Date | null,
    @CurrentUser() user: User | undefined,
  ): Promise<RequestListResponse> {
    if (limit < 1 || limit > LIST_MAX_LIMIT) {
      throw new BadRequestException(`limit must be between 1 and ${LIST_MAX_LIMIT}`);
    }
    return this.requests.list(endpointId.toLowerCase(), { limit, before }, user ?? null);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  detail(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Param('id', requestIdPipe) id: string,
    @CurrentUser() user: User | undefined,
  ): Promise<RequestDetail> {
    return this.requests.detail(endpointId.toLowerCase(), id.toLowerCase(), user ?? null);
  }

  /** Owner only (phase 8.3): free-text note on a request. */
  @Patch(':id')
  @UseGuards(AuthGuard)
  updateNote(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Param('id', requestIdPipe) id: string,
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(updateNoteSchema)) body: UpdateNoteBody,
  ): Promise<RequestDetail> {
    return this.requests.updateNote(endpointId.toLowerCase(), id.toLowerCase(), user, body.note);
  }

  /** Owner only (phase 8.3): re-send the request to a public URL. */
  @Post(':id/replay')
  @HttpCode(200)
  @UseGuards(AuthGuard, ThrottlerGuard)
  @Throttle(REPLAY_THROTTLE)
  replay(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Param('id', requestIdPipe) id: string,
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(replaySchema)) body: ReplayBody,
  ): Promise<ReplayResult> {
    return this.requests.replay(endpointId.toLowerCase(), id.toLowerCase(), user, body.target_url);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(OptionalAuthGuard)
  delete(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @Param('id', requestIdPipe) id: string,
    @CurrentUser() user: User | undefined,
  ): Promise<void> {
    return this.requests.delete(endpointId.toLowerCase(), id.toLowerCase(), user ?? null);
  }

  @Delete()
  @HttpCode(204)
  @UseGuards(OptionalAuthGuard)
  clear(
    @Param('endpointId', endpointIdPipe) endpointId: string,
    @CurrentUser() user: User | undefined,
  ): Promise<void> {
    return this.requests.clear(endpointId.toLowerCase(), user ?? null);
  }
}
