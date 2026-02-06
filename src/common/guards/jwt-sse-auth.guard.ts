import { Injectable, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT Auth Guard that supports token in query parameter
 * Needed for SSE endpoints since EventSource doesn't support custom headers
 */
@Injectable()
export class JwtSseAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtSseAuthGuard.name);

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();

    // If token is in query parameter, move it to Authorization header
    if (request.query?.token) {
      request.headers.authorization = `Bearer ${request.query.token}`;
      this.logger.debug(`[SSE Auth] Token found in query, moved to header`);
    } else {
      this.logger.warn(`[SSE Auth] No token in query params`);
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      this.logger.error(`[SSE Auth] Authentication failed - err: ${err?.message || 'none'}, info: ${info?.message || info || 'none'}, user: ${user ? 'exists' : 'null'}`);
      throw err || new UnauthorizedException('Invalid or missing authentication token');
    }
    this.logger.debug(`[SSE Auth] Authenticated user: ${user.email}`);
    return user;
  }
}
