import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { EndpointDetail, EndpointSummary } from '@yomail/shared';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { User } from '../users/user.entity';
import { EndpointsService } from './endpoints.service';
import { updateEndpointSchema } from './schemas';
import type { UpdateEndpointBody } from './schemas';

const idPipe = new ParseUUIDPipe({ version: '4' });

@Controller('endpoints')
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  /** No body expected: the id is generated server-side. Owned by the caller when signed in. */
  @Post()
  @HttpCode(201)
  @UseGuards(OptionalAuthGuard)
  create(@CurrentUser() user: User | undefined): Promise<EndpointSummary> {
    return this.endpoints.create(user?.id ?? null);
  }

  /** Public; `owned` and `response` are filled in for the owner's session. */
  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  detail(
    @Param('id', idPipe) id: string,
    @CurrentUser() user: User | undefined,
  ): Promise<EndpointDetail> {
    return this.endpoints.detail(id.toLowerCase(), user ?? null);
  }

  /** Owner only (phase 8): name and/or configured response. */
  @Patch(':id')
  @UseGuards(AuthGuard)
  update(
    @Param('id', idPipe) id: string,
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(updateEndpointSchema)) body: UpdateEndpointBody,
  ): Promise<EndpointDetail> {
    return this.endpoints.update(id.toLowerCase(), user, body);
  }

  /** A signed-in member takes an ownerless endpoint (phase 8). */
  @Post(':id/claim')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  claim(@Param('id', idPipe) id: string, @CurrentUser() user: User): Promise<EndpointDetail> {
    return this.endpoints.claim(id.toLowerCase(), user);
  }

  /** Anyone for an ownerless endpoint; the owner only once it has one. */
  @Delete(':id')
  @HttpCode(204)
  @UseGuards(OptionalAuthGuard)
  delete(@Param('id', idPipe) id: string, @CurrentUser() user: User | undefined): Promise<void> {
    return this.endpoints.delete(id.toLowerCase(), user ?? null);
  }
}
