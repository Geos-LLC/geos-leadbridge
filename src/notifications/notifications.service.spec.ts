import { NotificationsService } from './notifications.service';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Helper: build a minimal PrismaService mock
// ---------------------------------------------------------------------------
function buildPrismaMock() {
  return {
    savedAccount: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    notificationSettings: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    notificationRule: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    tenantPhoneNumber: {
      findFirst: jest.fn(),
    },
    notificationLog: {
      create: jest.fn(),
      update: jest.fn(),
    },
    adminConfig: {
      findUnique: jest.fn(),
    },
    lead: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    message: {
      create: jest.fn(),
    },
    conversation: {
      update: jest.fn(),
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal ConfigService mock
// ---------------------------------------------------------------------------
function buildConfigMock() {
  return {
    get: jest.fn().mockImplementation((key: string, defaultVal?: any) => defaultVal ?? ''),
  } as any as ConfigService;
}

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------
const USER_ID = 'user-1';
const ACCOUNT_ID = 'account-1';
const RULE_ID = 'rule-1';

const mockAccount = { id: ACCOUNT_ID, userId: USER_ID, businessName: 'Test Biz', agentPhoneOverride: null };
const mockSettings = {
  id: 'settings-1',
  savedAccountId: ACCOUNT_ID,
  enabled: true,
  sigcoreApiKey: 'sk-test-key',
  sigcoreWorkspaceId: 'ws-1',
  destinationPhone: '+15550000002',
  template: 'New lead: {{customerName}}',
};
const mockLogEntry = { id: 'log-1' };
const mockAdminConfig = { id: 'global', testData: {} };
const mockSigcoreResult = { status: 'sent', fromPhone: '+15551111111', provider: 'twilio', messageId: 'msg-1', conversationId: 'conv-1' };
const mockPhoneRecord = { id: 'phone-1', phoneNumber: '+15551111111', status: 'ACTIVE', savedAccountId: ACCOUNT_ID };
const mockCrossAccountPhone = { id: 'phone-2', phoneNumber: '+15552222222', status: 'ACTIVE', savedAccountId: 'other-account' };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const config = buildConfigMock();
    // Cache is opt-out by default — getLogsByLead is the only method that
    // touches it, and the existing tests don't exercise that path. Mocked
    // as a no-op so the constructor satisfies its DI contract.
    const cache: any = {
      getOrSet: jest.fn(async (_k: string, _ttl: number, loader: () => Promise<any>) => loader()),
      del: jest.fn().mockResolvedValue(undefined),
    };
    service = new NotificationsService(prisma, config, cache, {} as any);

    // Spy on private sendViaSigcore to avoid real HTTP calls
    jest.spyOn(service as any, 'sendViaSigcore').mockResolvedValue(mockSigcoreResult);

    // Default resolveAgentPhone spy
    jest.spyOn(service as any, 'resolveAgentPhone').mockResolvedValue('+15550000002');

    // Default shared prisma mocks
    prisma.savedAccount.findFirst.mockResolvedValue(mockAccount);
    prisma.notificationSettings.findUnique.mockResolvedValue(mockSettings);
    prisma.notificationSettings.findFirst.mockResolvedValue(mockSettings);
    prisma.notificationSettings.update.mockResolvedValue(mockSettings);
    prisma.notificationLog.create.mockResolvedValue(mockLogEntry);
    prisma.notificationLog.update.mockResolvedValue(mockLogEntry);
    prisma.adminConfig.findUnique.mockResolvedValue(mockAdminConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // resolveBotPhone — 3-step fallback chain
  // =========================================================================
  describe('resolveBotPhone – fallback chain', () => {
    it('Step 1: returns account-scoped number when found', async () => {
      prisma.tenantPhoneNumber.findFirst.mockResolvedValueOnce(mockPhoneRecord);

      const result = await (service as any).resolveBotPhone(USER_ID, ACCOUNT_ID);

      expect(result).toBe('+15551111111');
      expect(prisma.tenantPhoneNumber.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.tenantPhoneNumber.findFirst.mock.calls[0][0].where).toMatchObject({
        userId: USER_ID, savedAccountId: ACCOUNT_ID, status: 'ACTIVE',
      });
    });

    it('Step 2: falls back to null-savedAccountId number', async () => {
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)   // account-scoped
        .mockResolvedValueOnce({ ...mockPhoneRecord, savedAccountId: null }); // null-scoped

      const result = await (service as any).resolveBotPhone(USER_ID, ACCOUNT_ID);

      expect(result).toBe('+15551111111');
      expect(prisma.tenantPhoneNumber.findFirst).toHaveBeenCalledTimes(2);
      expect(prisma.tenantPhoneNumber.findFirst.mock.calls[1][0].where).toMatchObject({
        userId: USER_ID, savedAccountId: null, status: 'ACTIVE',
      });
    });

    it('Step 3: falls back to any active number for the user (cross-account)', async () => {
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)   // account-scoped
        .mockResolvedValueOnce(null)   // null-scoped
        .mockResolvedValueOnce(mockCrossAccountPhone); // any-user

      const result = await (service as any).resolveBotPhone(USER_ID, ACCOUNT_ID);

      expect(result).toBe('+15552222222');
      expect(prisma.tenantPhoneNumber.findFirst).toHaveBeenCalledTimes(3);
      // Third call should query userId only (no savedAccountId filter)
      expect(prisma.tenantPhoneNumber.findFirst.mock.calls[2][0].where).toMatchObject({
        userId: USER_ID, status: 'ACTIVE',
      });
      expect(prisma.tenantPhoneNumber.findFirst.mock.calls[2][0].where).not.toHaveProperty('savedAccountId');
    });

    it('returns null when no numbers exist at all', async () => {
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await (service as any).resolveBotPhone(USER_ID, ACCOUNT_ID);

      expect(result).toBeNull();
      expect(prisma.tenantPhoneNumber.findFirst).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // sendTestNotification — phone number fallback logic
  // =========================================================================
  describe('sendTestNotification – phone number fallback', () => {
    it('sends when resolveBotPhone returns a number', async () => {
      jest.spyOn(service as any, 'resolveBotPhone').mockResolvedValue('+15551111111');

      const result = await service.sendTestNotification(USER_ID, ACCOUNT_ID, undefined, '+15559999999');

      expect(result.success).toBe(true);
      expect((service as any).sendViaSigcore).toHaveBeenCalled();
    });

    it('returns error when resolveBotPhone returns null', async () => {
      jest.spyOn(service as any, 'resolveBotPhone').mockResolvedValue(null);

      const result = await service.sendTestNotification(USER_ID, ACCOUNT_ID, undefined, '+15559999999');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No dedicated number assigned. Get a dedicated number first.');
      expect((service as any).sendViaSigcore).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // sendNotificationWithRule — phone number fallback logic
  // =========================================================================
  describe('sendNotificationWithRule – phone number fallback', () => {
    const mockRule = {
      id: RULE_ID,
      name: 'Lead Alert - SMS',
      sendToCustomer: false,
      messageTemplate: { content: 'New lead: {{customerName}}' },
    };
    const mockLead = {
      id: 'lead-1',
      customerName: 'Test Customer',
      customerPhone: '+15558887777',
    };
    const context = {
      userId: USER_ID,
      savedAccountId: ACCOUNT_ID,
      leadId: 'lead-1',
      accountName: 'Test Biz',
      lead: mockLead,
    };

    it('sends when resolveBotPhone returns a number', async () => {
      jest.spyOn(service as any, 'resolveBotPhone').mockResolvedValue('+15551111111');

      await (service as any).sendNotificationWithRule(mockSettings, mockRule, context);

      expect((service as any).sendViaSigcore).toHaveBeenCalled();
    });

    it('skips send when resolveBotPhone returns null (logs error)', async () => {
      jest.spyOn(service as any, 'resolveBotPhone').mockResolvedValue(null);

      await (service as any).sendNotificationWithRule(mockSettings, mockRule, context);

      expect((service as any).sendViaSigcore).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // sendAdHocSms — phone number fallback logic
  // =========================================================================
  describe('sendAdHocSms – phone number fallback', () => {
    const LEAD_ID = 'lead-1';
    const MESSAGE = 'Hello customer!';
    const mockLead = {
      id: LEAD_ID,
      userId: USER_ID,
      customerPhone: '+15558887777',
      threadId: null,
    };

    beforeEach(() => {
      prisma.lead.findFirst.mockResolvedValue(mockLead);
    });

    it('sends when resolveBotPhone returns a number', async () => {
      jest.spyOn(service as any, 'resolveBotPhone').mockResolvedValue('+15551111111');

      const result = await service.sendAdHocSms(USER_ID, ACCOUNT_ID, LEAD_ID, MESSAGE);

      expect(result.success).toBe(true);
      expect((service as any).sendViaSigcore).toHaveBeenCalled();
    });

    it('returns error when resolveBotPhone returns null', async () => {
      jest.spyOn(service as any, 'resolveBotPhone').mockResolvedValue(null);

      const result = await service.sendAdHocSms(USER_ID, ACCOUNT_ID, LEAD_ID, MESSAGE);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No dedicated number assigned. Get a dedicated number first.');
      expect((service as any).sendViaSigcore).not.toHaveBeenCalled();
    });
  });
});
