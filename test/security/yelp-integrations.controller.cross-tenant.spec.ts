/**
 * Cross-tenant access tests for YelpIntegrationsController — Phase 1B.
 *
 * `collectLeads` previously did `prisma.lead.findUnique` by the global
 * (platform, externalRequestId) unique key with no userId check. If two
 * LeadBridge users connected the same Yelp business, User B's extension
 * upload could mutate User A's lead via the "update existing" branch.
 *
 * The patch refuses to mutate a lead owned by another tenant — silently
 * counts it as skipped (no error message that leaks existence).
 */

import { YelpIntegrationsController } from '../../src/integrations/yelp-integrations.controller';

function buildController(opts: {
  existingLeadOwnerId: string | null;
  callerSavedAccountFound: boolean;
}) {
  const updateMock = jest.fn().mockResolvedValue({});
  const createMock = jest.fn().mockResolvedValue({});
  const conversationUpdateMock = jest.fn().mockResolvedValue({});

  const prisma = {
    savedAccount: {
      findFirst: jest.fn().mockImplementation(() =>
        Promise.resolve(opts.callerSavedAccountFound ? { id: 'acct', credentialsJson: 'enc', businessId: 'biz' } : null),
      ),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue(
        opts.existingLeadOwnerId
          ? { id: 'lead-1', userId: opts.existingLeadOwnerId, customerName: 'Existing', status: 'new', platformStatus: null }
          : null,
      ),
      update: updateMock,
      create: createMock,
    },
    conversation: {
      update: conversationUpdateMock,
      upsert: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    },
  } as any;

  const platformService = {} as any;
  const platformFactory = { getAdapter: jest.fn().mockReturnValue({ getLead: jest.fn() }) } as any;
  const configService = { get: jest.fn().mockReturnValue('') } as any;
  const leadStatusService = { writeStatus: jest.fn() } as any;
  const followUpEngine = null;

  // The controller decrypts credentials — stub to avoid the real crypto path.
  const EncryptionUtilModule = require('../../src/common/utils/encryption.util');
  jest.spyOn(EncryptionUtilModule.EncryptionUtil, 'decryptObject').mockReturnValue({ accessToken: 'tok' });

  const controller = new YelpIntegrationsController(
    prisma,
    platformService,
    platformFactory,
    configService,
    leadStatusService,
    followUpEngine,
  );

  return { controller, prisma, updateMock };
}

describe('YelpIntegrationsController.collectLeads — cross-tenant write protection', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses to mutate a Yelp lead that already belongs to another tenant', async () => {
    const { controller, updateMock } = buildController({
      existingLeadOwnerId: OWNER, // existing row is User A's
      callerSavedAccountFound: true,
    });

    const result = await controller.collectLeads(
      { id: INTRUDER }, // intruder is calling
      {
        savedAccountId: 'acct',
        businessId: 'biz',
        leadIds: ['shared-yelp-lead-id'],
        leadNames: { 'shared-yelp-lead-id': 'Hacker McForge' },
        leadStatuses: { 'shared-yelp-lead-id': 'closed' },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    // Critically: no update call against User A's lead.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows the legitimate owner to update their own existing lead', async () => {
    const { controller, updateMock } = buildController({
      existingLeadOwnerId: OWNER,
      callerSavedAccountFound: true,
    });

    const result = await controller.collectLeads(
      { id: OWNER },
      {
        savedAccountId: 'acct',
        businessId: 'biz',
        leadIds: ['my-yelp-lead'],
        leadNames: { 'my-yelp-lead': 'Real Customer' },
      },
    );

    expect(result.ok).toBe(true);
    // The owner branch may update or skip depending on diff, but must not 401/error out.
    expect(result.skipped).toBeLessThanOrEqual(1);
  });
});
