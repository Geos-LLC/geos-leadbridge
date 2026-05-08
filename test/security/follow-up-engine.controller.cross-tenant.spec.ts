/**
 * Cross-tenant access tests for FollowUpEngineController — Phase 0 hotfix.
 *
 * Before Phase 0 the enrollment endpoints looked up rows by id with no
 * ownership check, so User B could read/stop/pause/resume User A's
 * enrollments. Regression check: every `:id` route must call
 * TenancyService.requireEnrollmentAccess first and throw NotFoundException
 * (never Forbidden) on mismatch.
 */

import { NotFoundException } from '@nestjs/common';
import { FollowUpEngineController } from '../../src/follow-up-engine/follow-up-engine.controller';
import { TenancyService } from '../../src/common/tenancy/tenancy.service';

function buildPrisma(ownerUserId: string) {
  return {
    followUpEnrollment: {
      // Success only when the caller is the owner.
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.conversation?.userId === ownerUserId) {
          return Promise.resolve({ id: where.id });
        }
        return Promise.resolve(null);
      }),
      // getEnrollment's second call — inner fetch using `findUnique`. Only
      // reached when ownership passes; safe to return a canned row.
      findUnique: jest.fn().mockResolvedValue({
        id: 'e1',
        sequenceTemplate: {},
        stepExecutions: [],
        lead: { customerName: 'A', category: 'cleaning', city: null, state: null },
      }),
    },
  } as any;
}

function buildEngineService() {
  return {
    stopEnrollment: jest.fn().mockResolvedValue(undefined),
    pauseEnrollment: jest.fn().mockResolvedValue(undefined),
    resumeEnrollment: jest.fn().mockResolvedValue(undefined),
    enrollInSequence: jest.fn().mockResolvedValue('new-enrollment'),
  } as any;
}

function makeController(ownerUserId: string) {
  const prisma = buildPrisma(ownerUserId);
  const engineService = buildEngineService();
  const tenancy = new TenancyService(prisma);
  const controller = new FollowUpEngineController(
    engineService,
    prisma,
    tenancy,
    {} as any, // LeadsService — not exercised by enrollment endpoints under test
    {} as any, // ConversationContextService
    {} as any, // FollowUpGeneratorService
    {} as any, // TrialService
    {} as any, // FollowUpGateService — not exercised by enrollment endpoints under test
  );
  return { controller, prisma, engineService };
}

describe('FollowUpEngineController — cross-tenant enrollment access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const ENROLLMENT_ID = 'e1';

  describe('when the caller owns the enrollment', () => {
    const user = { id: OWNER } as any;

    it('getEnrollment returns data', async () => {
      const { controller } = makeController(OWNER);
      const res = await controller.getEnrollment(user, ENROLLMENT_ID);
      expect(res.success).toBe(true);
    });

    it('stop dispatches to engine service', async () => {
      const { controller, engineService } = makeController(OWNER);
      const res = await controller.stop(user, ENROLLMENT_ID, 'manual');
      expect(res).toEqual({ success: true });
      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'manual');
    });

    it('pause dispatches to engine service', async () => {
      const { controller, engineService } = makeController(OWNER);
      const res = await controller.pause(user, ENROLLMENT_ID);
      expect(res).toEqual({ success: true });
      expect(engineService.pauseEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID);
    });

    it('resume dispatches to engine service', async () => {
      const { controller, engineService } = makeController(OWNER);
      const res = await controller.resume(user, ENROLLMENT_ID);
      expect(res).toEqual({ success: true });
      expect(engineService.resumeEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID);
    });
  });

  describe('when a different user tries to act on an enrollment they do not own', () => {
    const intruder = { id: INTRUDER } as any;

    it('getEnrollment throws NotFoundException and does NOT leak the row', async () => {
      const { controller, prisma } = makeController(OWNER);
      await expect(controller.getEnrollment(intruder, ENROLLMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.followUpEnrollment.findUnique).not.toHaveBeenCalled();
    });

    it('stop throws NotFoundException and does NOT mutate the enrollment', async () => {
      const { controller, engineService } = makeController(OWNER);
      await expect(controller.stop(intruder, ENROLLMENT_ID, 'manual')).rejects.toBeInstanceOf(NotFoundException);
      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
    });

    it('pause throws NotFoundException and does NOT pause', async () => {
      const { controller, engineService } = makeController(OWNER);
      await expect(controller.pause(intruder, ENROLLMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(engineService.pauseEnrollment).not.toHaveBeenCalled();
    });

    it('resume throws NotFoundException and does NOT resume', async () => {
      const { controller, engineService } = makeController(OWNER);
      await expect(controller.resume(intruder, ENROLLMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(engineService.resumeEnrollment).not.toHaveBeenCalled();
    });
  });
});
