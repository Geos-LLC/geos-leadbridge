/**
 * SupportGrants DTO — controller-level validation spec.
 *
 * Phase 3 shipped CreateSupportGrantDto without class-validator decorators.
 * Combined with the global `ValidationPipe({ whitelist: true,
 * forbidNonWhitelisted: true })` in main.ts, every property got stripped and
 * the controller received `{}` — making POST /v1/me/support-grants
 * uncallable from any HTTP client. The previous service-level spec in
 * support-grants.service.spec.ts didn't catch it because those tests call
 * the service directly and bypass the pipe.
 *
 * This spec runs raw bodies through the same ValidationPipe config that
 * main.ts uses, so it asserts what an HTTP request actually goes through
 * before reaching the controller. Service-layer business rules (whitespace
 * reason, 7-day max, reason truncation) stay covered by the service spec.
 */

import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { CreateSupportGrantDto } from '../../src/admin/support-grants/dto/create-support-grant.dto';
import { SupportGrantsController } from '../../src/admin/support-grants/support-grants.controller';

// Same shape as main.ts useGlobalPipes() — the test must match production.
function buildPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

const META: ArgumentMetadata = {
  type: 'body',
  metatype: CreateSupportGrantDto,
  data: '',
};

async function run(body: any) {
  return buildPipe().transform(body, META);
}

describe('CreateSupportGrantDto — accepts valid bodies (regression for the Phase 3 strip-everything bug)', () => {
  it('passes a full valid body through the pipe unchanged', async () => {
    const body = {
      tenantId: 'tenant-a',
      scopes: ['user:read'],
      reason: 'Customer reported missing leads',
      durationMinutes: 30,
    };
    const out = await run(body);
    // Properties survive the whitelist (the original bug was that they did NOT).
    expect(out).toEqual(body);
    // transform: true — durationMinutes stays a number, not a string.
    expect(typeof out.durationMinutes).toBe('number');
  });

  it('passes a valid body without optional durationMinutes', async () => {
    const body = {
      tenantId: '__platform__',
      scopes: ['notifications:read', 'phones:read'],
      reason: 'Fleet alert investigation',
    };
    const out = await run(body);
    expect(out).toMatchObject(body);
    expect(out.durationMinutes).toBeUndefined();
  });
});

describe('CreateSupportGrantDto — rejects invalid bodies', () => {
  it('rejects a missing tenantId', async () => {
    await expect(
      run({ scopes: ['user:read'], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-string tenantId', async () => {
    await expect(
      run({ tenantId: 42, scopes: ['user:read'], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing scopes array', async () => {
    await expect(
      run({ tenantId: 't', reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty scopes array', async () => {
    await expect(
      run({ tenantId: 't', scopes: [], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-string scope entry', async () => {
    await expect(
      run({ tenantId: 't', scopes: ['user:read', 99], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing reason', async () => {
    await expect(
      run({ tenantId: 't', scopes: ['user:read'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty reason', async () => {
    await expect(
      run({ tenantId: 't', scopes: ['user:read'], reason: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects durationMinutes=0 (Min(1))', async () => {
    await expect(
      run({ tenantId: 't', scopes: ['user:read'], reason: 'ok', durationMinutes: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown extra property (forbidNonWhitelisted)', async () => {
    await expect(
      run({
        tenantId: 't',
        scopes: ['user:read'],
        reason: 'ok',
        rogueProperty: 'should be rejected',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SupportGrantsController.create — end-to-end through the pipe', () => {
  it('after the pipe accepts the body, controller.create reaches the service with it', async () => {
    const body = {
      tenantId: '__platform__',
      scopes: ['user:list'],
      reason: 'Phase 4 live verification',
      durationMinutes: 15,
    };
    const validatedBody = (await run(body)) as CreateSupportGrantDto;

    const supportGrantsService: any = {
      createGrant: jest.fn().mockResolvedValue({
        id: 'sg-1',
        tenantId: '__platform__',
        scopes: ['user:list'],
        reason: 'Phase 4 live verification',
        expiresAt: new Date(Date.now() + 15 * 60_000),
        createdAt: new Date(),
      }),
    };
    const controller = new SupportGrantsController(supportGrantsService);

    const req: any = { user: { id: 'admin-1', role: 'ADMIN' } };
    const result = await controller.create(req, validatedBody);

    expect(supportGrantsService.createGrant).toHaveBeenCalledWith('admin-1', validatedBody);
    expect(result).toMatchObject({
      success: true,
      grant: {
        id: 'sg-1',
        tenantId: '__platform__',
        scopes: ['user:list'],
        reason: 'Phase 4 live verification',
      },
    });
  });
});
