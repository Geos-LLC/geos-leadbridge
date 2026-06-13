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

// ─── Config summary (Wizard ↔ Settings sync) ─────────────────────────
// The summary endpoint backs the data-driven sidebar tick for the four
// stored-only wizard steps. These tests pin the predicates so a
// schema-shape drift on AccountFaqForm / ServicePricingForm /
// followUpSettings doesn't silently break the green tick.

function buildSummaryPrisma(account: any | null) {
  return {
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue(account),
    },
  } as any;
}

describe('OnboardingService.getConfigSummary', () => {
  it('returns all-false when the user has no SavedAccount', async () => {
    const svc = service(buildSummaryPrisma(null));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary).toEqual({
      faqConfigured: false,
      pricingConfigured: false,
      automationConfigured: false,
      aiRulesConfigured: false,
    });
  });

  it('returns all-false when the primary account has empty JSON columns', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: null,
      followUpSettingsJson: null,
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary).toEqual({
      faqConfigured: false,
      pricingConfigured: false,
      automationConfigured: false,
      aiRulesConfigured: false,
    });
  });

  it('treats an FAQ where every value is the default "unset" as NOT configured', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: JSON.stringify({
        insuredAndBonded: { value: 'unset' },
        bringsSupplies: { value: 'unset' },
        paymentMethods: [],
        customQA: [],
      }),
      servicePricingJson: null,
      followUpSettingsJson: null,
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.faqConfigured).toBe(false);
  });

  it('marks FAQ configured when at least one value is set away from "unset"', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: JSON.stringify({ insuredAndBonded: { value: 'yes' } }),
      servicePricingJson: null,
      followUpSettingsJson: null,
    }));
    expect((await svc.getConfigSummary('u-1')).faqConfigured).toBe(true);
  });

  it('marks FAQ configured when only paymentMethods or scope strings are filled', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: JSON.stringify({ paymentMethods: ['cash'] }),
      servicePricingJson: null,
      followUpSettingsJson: null,
    }));
    expect((await svc.getConfigSummary('u-1')).faqConfigured).toBe(true);
  });

  it('marks Pricing configured only when priceTable has at least one row', async () => {
    const empty = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: JSON.stringify({ priceTable: [] }),
      followUpSettingsJson: null,
    }));
    expect((await empty.getConfigSummary('u-1')).pricingConfigured).toBe(false);

    const filled = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: JSON.stringify({ priceTable: [{ bed: 1, bath: 1, regular: 100 }] }),
      followUpSettingsJson: null,
    }));
    expect((await filled.getConfigSummary('u-1')).pricingConfigured).toBe(true);
  });

  it('marks Automation configured when followUpSettingsJson.mode is present', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: null,
      followUpSettingsJson: JSON.stringify({ mode: 'auto_send' }),
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.automationConfigured).toBe(true);
    // followUpStrategy is the AI Rules signal — absent here.
    expect(summary.aiRulesConfigured).toBe(false);
  });

  it('marks AI Rules configured when followUpSettingsJson.followUpStrategy is present', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: null,
      followUpSettingsJson: JSON.stringify({ followUpStrategy: 'qualify' }),
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.aiRulesConfigured).toBe(true);
  });

  it('tolerates malformed JSON without throwing', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: '{not json',
      servicePricingJson: '[also broken',
      followUpSettingsJson: 'nope',
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary).toEqual({
      faqConfigured: false,
      pricingConfigured: false,
      automationConfigured: false,
      aiRulesConfigured: false,
    });
  });
});
