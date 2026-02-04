import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT Auth Guard that supports token in query parameter
 * Needed for SSE endpoints since EventSource doesn't support custom headers
 */
@Injectable()
export class JwtSseAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();

    // If token is in query parameter, move it to Authorization header
    if (request.query?.token) {
      request.headers.authorization = `Bearer ${request.query.token}`;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or missing authentication token');
    }
    return user;
  }
}
