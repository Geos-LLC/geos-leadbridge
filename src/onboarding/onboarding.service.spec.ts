/**
 * Unit tests for OnboardingService.patchWizard — the merge logic that
 * powers the 8-step guided setup wizard. The function is the single
 * source of truth for "advance the current step + mark one step
 * done/skipped + optionally flag the wizard complete", and the
 * frontend container fires it on every Back / Skip / Continue click.
 *
 * These tests pin the four contract pieces that matter for resume:
 *
 *   1. wizardStartedAt is set exactly once (first PATCH); subsequent
 *      PATCHes don't bump it.
 *   2. markStep merges into the existing checklistStatus map — the
 *      caller only sends the one step they just finished, the service
 *      preserves all previous entries.
 *   3. skippedSteps stays in sync with the checklist: adding a
 *      'skipped' entry inserts; re-marking 'done' removes.
 *   4. completed=true sets wizardCompletedAt; absent or false doesn't.
 *
 * Invalid step slugs are also pinned so the controller's BadRequest
 * guard cannot drift away from what the service accepts.
 */
import { OnboardingService } from './onboarding.service';

function buildPrismaMock(initial: any = {}) {
  // Holds the simulated row so upsert acts like a real upsert across
  // multiple calls in a single test.
  let row: any = initial;
  return {
    onboardingProfile: {
      findUnique: jest.fn().mockImplementation(async () => row),
      upsert: jest.fn().mockImplementation(async ({ create, update }: any) => {
        if (!row) {
          row = { id: 'op-1', userId: 'u-1', wizardSkippedSteps: [], ...create };
        } else {
          row = { ...row, ...update };
          // Postgres-like array handling: when update provides the
          // array key, replace; otherwise keep existing.
          if (Array.isArray(update.wizardSkippedSteps)) {
            row.wizardSkippedSteps = update.wizardSkippedSteps;
          }
        }
        return row;
      }),
    },
  } as any;
}

function service(prisma: any) {
  return new OnboardingService(prisma);
}

describe('OnboardingService.patchWizard', () => {
  it('sets wizardStartedAt on the first call and does not reset it on later calls', async () => {
    const prisma = buildPrismaMock(null);
    const svc = service(prisma);

    const first = await svc.patchWizard('u-1', { currentStep: 'welcome' });
    expect(first.wizardStartedAt).toBeInstanceOf(Date);
    const initialStartedAt = first.wizardStartedAt;

    // Simulate that the mock now reflects the persisted row.
    const second = await svc.patchWizard('u-1', { currentStep: 'connect' });
    expect(second.wizardStartedAt).toBe(initialStartedAt);
  });

  it('merges markStep into existing checklistStatus rather than replacing it', async () => {
    const prisma = buildPrismaMock(null);
    const svc = service(prisma);

    await svc.patchWizard('u-1', { markStep: { step: 'connect', status: 'done' } });
    await svc.patchWizard('u-1', { markStep: { step: 'business', status: 'done' } });
    const after = await svc.patchWizard('u-1', { markStep: { step: 'ai', status: 'skipped' } });

    expect(after.wizardChecklistStatus).toEqual({
      connect: 'done',
      business: 'done',
      ai: 'skipped',
    });
  });

  it('adds the slug to skippedSteps when status=skipped and removes it when re-marked done', async () => {
    const prisma = buildPrismaMock(null);
    const svc = service(prisma);

    const skipped = await svc.patchWizard('u-1', { markStep: { step: 'pricing', status: 'skipped' } });
    expect(skipped.wizardSkippedSteps).toEqual(['pricing']);

    const recovered = await svc.patchWizard('u-1', { markStep: { step: 'pricing', status: 'done' } });
    expect(recovered.wizardSkippedSteps).toEqual([]);
    expect(recovered.wizardChecklistStatus).toEqual({ pricing: 'done' });
  });

  it('sets wizardCompletedAt only when completed=true is passed', async () => {
    const prisma = buildPrismaMock(null);
    const svc = service(prisma);

    const inProgress = await svc.patchWizard('u-1', { markStep: { step: 'ai_rules', status: 'done' } });
    expect(inProgress.wizardCompletedAt).toBeFalsy();

    const finished = await svc.patchWizard('u-1', {
      markStep: { step: 'done', status: 'done' },
      currentStep: 'done',
      completed: true,
    });
    expect(finished.wizardCompletedAt).toBeInstanceOf(Date);
  });

  it('rejects unknown step slugs in markStep and currentStep', async () => {
    const prisma = buildPrismaMock(null);
    const svc = service(prisma);

    await expect(
      svc.patchWizard('u-1', { markStep: { step: 'not_a_step' as any, status: 'done' } }),
    ).rejects.toThrow(/Invalid wizard step/);

    await expect(
      svc.patchWizard('u-1', { currentStep: 'wat' as any }),
    ).rejects.toThrow(/Invalid wizard step/);
  });

  it('preserves prior progress when only currentStep is sent (Back button case)', async () => {
    const prisma = buildPrismaMock(null);
    const svc = service(prisma);

    await svc.patchWizard('u-1', { markStep: { step: 'connect', status: 'done' } });
    await svc.patchWizard('u-1', { markStep: { step: 'business', status: 'skipped' } });

    // Back from "ai" to "business" — the wizard should not lose either
    // existing checklist entry. This is the case that matters for
    // resume-on-reload.
    const after = await svc.patchWizard('u-1', { currentStep: 'business' });
    expect(after.wizardCurrentStep).toBe('business');
    expect(after.wizardChecklistStatus).toEqual({
      connect: 'done',
      business: 'skipped',
    });
    expect(after.wizardSkippedSteps).toEqual(['business']);
  });
});
