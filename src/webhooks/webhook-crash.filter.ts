/**
 * WebhookCrashFilter — catches uncaught exceptions inside webhook
 * controller handlers and pages ops, then returns a clean HTTP error
 * so the upstream platform's retry logic still works.
 *
 * Why this exists:
 *   - Webhook handlers run on a tight loop with millions of inbound
 *     events; one bad code change can crash on every payload and the
 *     only signal today is `level=error` log lines that nobody sees
 *     until a tenant calls to ask "why aren't my leads showing up?"
 *   - HttpException subclasses (BadRequest, NotFound, etc.) are
 *     deliberate, expected control flow — those PASS THROUGH unchanged
 *     so they don't burn the burst-detector budget or page ops over a
 *     malformed payload.
 *   - All other throws (TypeError, undefined-access, Prisma errors,
 *     unexpected axios failures, etc.) are unexpected: they record
 *     into the per-instance burst window AND fire notifyDevAlert with
 *     a 24h dedup key tied to the exception class + handler so a
 *     persistent regression pages once per day, not once per webhook.
 *
 * Returns HTTP 500 with a minimal JSON body so the platform retries
 * (TT and Yelp both retry on 5xx). If we returned 200 the platform
 * would never retry and the dropped event is lost — which is exactly
 * the failure mode this filter is meant to surface, not paper over.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { MonitoringService } from '../monitoring/monitoring.service';

@Catch()
export class WebhookCrashFilter implements ExceptionFilter {
  private readonly logger = new Logger(WebhookCrashFilter.name);

  constructor(@Optional() private readonly monitoring: MonitoringService | null = null) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    // Deliberate control-flow exceptions (HttpException et al.) pass through
    // to NestJS's default handler so 4xx responses on bad payloads stay
    // 4xx and don't fire ops pages.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { message: body } : body);
      return;
    }

    // Unexpected throw — page ops + write to the burst window.
    const err = exception as Error;
    const errName = err?.name || 'Error';
    const errMessage = err?.message || String(exception);
    // `path` includes the webhook subroute (e.g. /webhooks/thumbtack) so
    // the dedup key separates a TT-handler regression from a Yelp one.
    const path = (req?.originalUrl || req?.url || 'unknown').split('?')[0];

    this.logger.error(
      `[WebhookCrash] ${errName} in ${path}: ${errMessage}\n${err?.stack || '(no stack)'}`,
    );

    if (this.monitoring) {
      // Burst counter: drives platform_burst_webhook_handler_crash if
      // this fires repeatedly in 15 min.
      this.monitoring.recordPlatformFailure('webhook_handler_crash');

      // Immediate dev alert keyed by handler+exception class so the
      // 24h dedup matches "same bug, same handler".
      const kind = `webhook_crash_${path.replace(/[^\w]+/g, '_')}_${errName}`;
      void this.monitoring
        .notifyDevAlert({
          kind,
          subject: `LeadBridge: webhook handler crashed (${path})`,
          message: `Uncaught ${errName} in ${path}: ${errMessage}`,
          context: {
            path,
            errName,
            errMessage,
            stack: err?.stack?.split('\n').slice(0, 8).join('\n'),
          },
        })
        .catch((notifyErr) =>
          this.logger.error(`[WebhookCrash] notifyDevAlert failed: ${notifyErr?.message || notifyErr}`),
        );
    }

    // Surface as 500 so the platform retries — see header comment for why
    // we deliberately don't 200 to make the bug "go away".
    res.status(500).json({ error: 'webhook_handler_internal_error' });
  }
}
