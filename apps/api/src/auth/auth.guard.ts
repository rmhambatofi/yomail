import { createParamDecorator, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '@yomail/shared';
import { SessionsService } from '../users/sessions.service';
import type { SessionWithUser } from '../users/sessions.service';
import { authError } from './auth-error';
import { readSessionCookie } from './session-cookie';

/** What the guards attach to the Express request. */
export type AuthenticatedRequest = Request & { auth?: SessionWithUser };

async function attachAuth(
  ctx: ExecutionContext,
  sessions: SessionsService,
): Promise<SessionWithUser | null> {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (req.auth) return req.auth;
  const auth = await sessions.resolve(readSessionCookie(req));
  if (auth) req.auth = auth;
  return auth;
}

/** 401 UNAUTHENTICATED unless the cookie maps to a live session of an ENABLED user. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const auth = await attachAuth(ctx, this.sessions);
    if (!auth) throw authError.unauthenticated();
    return true;
  }
}

/** Attaches the user when a valid session is present, never refuses. */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await attachAuth(ctx, this.sessions);
    return true;
  }
}

export const ROLES_KEY = 'auth:roles';
/** Use after AuthGuard: `@UseGuards(AuthGuard, RolesGuard) @Roles('ADMIN')`. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = req.auth?.user.role;
    if (!role || !roles.includes(role)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}

/** The authenticated user entity (undefined behind OptionalAuthGuard when anonymous). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth?.user;
});

/** The current session row (undefined when anonymous). */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth?.session;
});
