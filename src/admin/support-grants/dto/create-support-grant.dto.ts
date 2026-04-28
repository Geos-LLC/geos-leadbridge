/**
 * POST /v1/me/support-grants — input DTO.
 *
 * The class-validator decorators below are required because main.ts wires a
 * global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`.
 * Without decorators every property is stripped as non-whitelisted, the
 * controller receives `{}`, and the service rejects the empty body — making
 * this endpoint uncallable from any HTTP client.
 *
 * The decorators here are intentionally minimal: structural shape only. The
 * service layer continues to enforce the business rules (whitespace-only
 * reason, 7-day max duration, etc.) so its existing unit tests keep covering
 * those cases.
 */
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateSupportGrantDto {
  @IsString()
  @IsNotEmpty()
  tenantId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;
}
