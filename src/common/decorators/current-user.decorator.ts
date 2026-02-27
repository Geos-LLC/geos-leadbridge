/**
 * Current User Decorator
 * Extracts current user from request.
 * Returns the impersonated user if admin "View As" is active,
 * otherwise returns the authenticated user from the JWT.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.impersonatedAs ?? request.user;
  },
);
