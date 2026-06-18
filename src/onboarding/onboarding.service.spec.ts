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
// The summary endpoint backs the data-driven sidebar tick for each
// wizard step. These tests pin the predicates so a schema-shape drift
// on AccountFaqForm / ServicePricingForm / followUpSettings / per
// ServiceProfile JSON doesn't silently break the green tick.

interface SummaryFixture {
  primary: any | null;
  accounts?: Array<{ id: string; serviceProfileAssignmentsJson: string | null }>;
  profiles?: Array<{
    id: string;
    name: string;
    status: 'active' | 'draft' | 'archived';
    pricingJson?: string | null;
    faqJson?: string | null;
    qualificationSchemaJson?: string | null;
  }>;
}

function buildSummaryPrisma(fixture: SummaryFixture | any) {
  // Back-compat: legacy tests pass the primary SavedAccount row
  // directly. New tests pass a `SummaryFixture` shape.
  const isFixture = fixture && (
    Object.prototype.hasOwnProperty.call(fixture, 'primary')
    || Object.prototype.hasOwnProperty.call(fixture, 'accounts')
    || Object.prototype.hasOwnProperty.call(fixture, 'profiles')
  );
  const primary = isFixture ? fixture.primary : fixture;
  const accounts = (isFixture && fixture.accounts) || (primary ? [{ id: 'sa-1', serviceProfileAssignmentsJson: null }] : []);
  const profiles = (isFixture && fixture.profiles) || [];

  return {
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue(primary),
      findMany: jest.fn().mockResolvedValue(accounts),
    },
    serviceProfile: {
      findMany: jest.fn().mockResolvedValue(profiles),
    },
  } as any;
}

describe('OnboardingService.getConfigSummary (legacy back-compat shape)', () => {
  it('returns the legacy four booleans all false when the user has no SavedAccount', async () => {
    const svc = service(buildSummaryPrisma({ primary: null, accounts: [], profiles: [] }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.faqConfigured).toBe(false);
    expect(summary.pricingConfigured).toBe(false);
    expect(summary.automationConfigured).toBe(false);
    expect(summary.aiRulesConfigured).toBe(false);
  });

  it('returns the legacy four booleans all false when the primary account has empty JSON columns', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: null,
      followUpSettingsJson: null,
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.faqConfigured).toBe(false);
    expect(summary.pricingConfigured).toBe(false);
    expect(summary.automationConfigured).toBe(false);
    expect(summary.aiRulesConfigured).toBe(false);
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
    expect(summary.aiRulesConfigured).toBe(false);
  });

  it('marks AI Rules configured when followUpSettingsJson.followUpStrategy is present', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: null,
      servicePricingJson: null,
      followUpSettingsJson: JSON.stringify({ followUpStrategy: 'qualify' }),
    }));
    expect((await svc.getConfigSummary('u-1')).aiRulesConfigured).toBe(true);
  });

  it('tolerates malformed JSON without throwing', async () => {
    const svc = service(buildSummaryPrisma({
      faqJson: '{not json',
      servicePricingJson: '[also broken',
      followUpSettingsJson: 'nope',
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.faqConfigured).toBe(false);
    expect(summary.pricingConfigured).toBe(false);
    expect(summary.automationConfigured).toBe(false);
    expect(summary.aiRulesConfigured).toBe(false);
  });
});

describe('OnboardingService.getConfigSummary (multi-service rollup)', () => {
  it('reports zero services and zero accounts for a brand-new tenant', async () => {
    const svc = service(buildSummaryPrisma({ primary: null, accounts: [], profiles: [] }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.connect).toEqual({ done: false, accountCount: 0 });
    expect(summary.services).toEqual({
      done: false,
      activeServiceCount: 0,
      totalAccounts: 0,
      accountsWithAssignments: 0,
    });
    expect(summary.serviceSetup.done).toBe(false);
    expect(summary.serviceSetup.services).toEqual([]);
    expect(summary.automation).toEqual({ done: false, mode: null });
  });

  it('one connected account + one default active service with full setup = services + serviceSetup both done', async () => {
    // Spec test #1: single-default-service tenant should pass cleanly.
    const svc = service(buildSummaryPrisma({
      primary: null,
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: '{"enabledServiceProfileIds":["sp-1"]}' }],
      profiles: [{
        id: 'sp-1',
        name: 'House Cleaning',
        status: 'active',
        pricingJson: JSON.stringify({ priceTable: [{ bed: 1, bath: 1, regular: 100 }] }),
        faqJson: JSON.stringify({ customQA: [{ question: 'Do you bring supplies?', answer: 'Yes' }] }),
        qualificationSchemaJson: null,
      }],
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.services.done).toBe(true);
    expect(summary.services.activeServiceCount).toBe(1);
    expect(summary.services.accountsWithAssignments).toBe(1);
    expect(summary.serviceSetup.done).toBe(true);
    expect(summary.serviceSetup.services).toHaveLength(1);
    expect(summary.serviceSetup.services[0]).toMatchObject({
      id: 'sp-1',
      status: 'active',
      pricingConfigured: true,
      customerAnswersConfigured: true,
      serviceOptionsConfigured: false,
    });
  });

  it('two active services where one is incomplete = serviceSetup NOT done; services list reports per-service state', async () => {
    // Spec test #2: per-service completion detection.
    const svc = service(buildSummaryPrisma({
      primary: null,
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: '{"enabledServiceProfileIds":["sp-1","sp-2"]}' }],
      profiles: [
        {
          id: 'sp-1',
          name: 'House Cleaning',
          status: 'active',
          pricingJson: JSON.stringify({ priceTable: [{ bed: 1, bath: 1, regular: 100 }] }),
          faqJson: JSON.stringify({ customQA: [{ question: 'Q', answer: 'A' }] }),
        },
        {
          id: 'sp-2',
          name: 'Upholstery',
          status: 'active',
          pricingJson: null,
          faqJson: null,
        },
      ],
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.services.done).toBe(true); // active services exist + assignments configured
    expect(summary.services.activeServiceCount).toBe(2);
    expect(summary.serviceSetup.done).toBe(false); // sp-2 incomplete
    const sp2 = summary.serviceSetup.services.find(s => s.id === 'sp-2')!;
    expect(sp2.pricingConfigured).toBe(false);
    expect(sp2.customerAnswersConfigured).toBe(false);
  });

  it('draft services do not block serviceSetup.done even when empty', async () => {
    // Spec confirmation: drafts are reported but do not gate completion.
    const svc = service(buildSummaryPrisma({
      primary: null,
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: '{"enabledServiceProfileIds":["sp-1"]}' }],
      profiles: [
        {
          id: 'sp-1',
          name: 'House Cleaning',
          status: 'active',
          pricingJson: JSON.stringify({ priceTable: [{ bed: 1, bath: 1, regular: 100 }] }),
          faqJson: JSON.stringify({ customQA: [{ question: 'Q', answer: 'A' }] }),
        },
        {
          id: 'sp-draft',
          name: 'Upholstery (draft)',
          status: 'draft',
          pricingJson: null,
          faqJson: null,
        },
      ],
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.serviceSetup.done).toBe(true);
    const draft = summary.serviceSetup.services.find(s => s.id === 'sp-draft')!;
    expect(draft.status).toBe('draft');
    expect(draft.pricingConfigured).toBe(false);
    expect(draft.customerAnswersConfigured).toBe(false);
  });

  it('quoteRequired pricing counts as configured even with no priceTable rows', async () => {
    const svc = service(buildSummaryPrisma({
      primary: null,
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: '{"enabledServiceProfileIds":["sp-1"]}' }],
      profiles: [{
        id: 'sp-1',
        name: 'Custom Quote Service',
        status: 'active',
        pricingJson: JSON.stringify({ quoteRequired: true }),
        faqJson: JSON.stringify({ customQA: [{ question: 'Q', answer: 'A' }] }),
      }],
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.serviceSetup.services[0].pricingConfigured).toBe(true);
    expect(summary.serviceSetup.done).toBe(true);
  });

  it('services step requires at least one active service AND at least one account assigned', async () => {
    // Spec test #3: assignments + active service requirement.
    // Active service exists but no account has been assigned yet.
    const noAssignments = service(buildSummaryPrisma({
      primary: null,
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: null }],
      profiles: [{
        id: 'sp-1',
        name: 'House Cleaning',
        status: 'active',
        pricingJson: JSON.stringify({ priceTable: [{ bed: 1, bath: 1, regular: 100 }] }),
        faqJson: JSON.stringify({ customQA: [{ question: 'Q', answer: 'A' }] }),
      }],
    }));
    expect((await noAssignments.getConfigSummary('u-1')).services.done).toBe(false);

    // Account has assignments but no active service exists.
    const noActiveService = service(buildSummaryPrisma({
      primary: null,
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: '{"enabledServiceProfileIds":[]}' }],
      profiles: [{
        id: 'sp-1',
        name: 'House Cleaning (draft only)',
        status: 'draft',
        pricingJson: null,
        faqJson: null,
      }],
    }));
    expect((await noActiveService.getConfigSummary('u-1')).services.done).toBe(false);
  });

  it('does not depend on primary SavedAccount FAQ/pricing for serviceSetup', async () => {
    // Spec test #4: wizard does not depend on first SavedAccount FAQ/pricing.
    // Primary account is intentionally empty; the ServiceProfile carries
    // the real configuration. serviceSetup.done must still flip true.
    const svc = service(buildSummaryPrisma({
      primary: {
        faqJson: null,
        servicePricingJson: null,
        followUpSettingsJson: null,
      },
      accounts: [{ id: 'sa-1', serviceProfileAssignmentsJson: '{"enabledServiceProfileIds":["sp-1"]}' }],
      profiles: [{
        id: 'sp-1',
        name: 'House Cleaning',
        status: 'active',
        pricingJson: JSON.stringify({ priceTable: [{ bed: 1, bath: 1, regular: 100 }] }),
        faqJson: JSON.stringify({ customQA: [{ question: 'Q', answer: 'A' }] }),
      }],
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.serviceSetup.done).toBe(true);
    // And the legacy SavedAccount-derived booleans correctly stay false.
    expect(summary.faqConfigured).toBe(false);
    expect(summary.pricingConfigured).toBe(false);
  });

  it('automation.mode is returned alongside the legacy automationConfigured boolean', async () => {
    const svc = service(buildSummaryPrisma({
      primary: {
        faqJson: null,
        servicePricingJson: null,
        followUpSettingsJson: JSON.stringify({ mode: 'recommended' }),
      },
      accounts: [],
      profiles: [],
    }));
    const summary = await svc.getConfigSummary('u-1');
    expect(summary.automation).toEqual({ done: true, mode: 'recommended' });
    expect(summary.automationConfigured).toBe(true);
  });
});
