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
  sigcoreFromPhone: '+15550000001',
  sigcoreWorkspaceId: 'ws-1',
  destinationPhone: '+15550000002',
  template: 'New lead: {{customerName}}',
};
const mockLogEntry = { id: 'log-1' };
const mockAdminConfig = { id: 'global', testData: {} };
const mockSigcoreResult = { status: 'sent', fromPhone: '+15551111111', provider: 'twilio', messageId: 'msg-1', conversationId: 'conv-1' };
const mockPhoneRecord = { id: 'phone-1', phoneNumber: '+15551111111', status: 'ACTIVE' };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const config = buildConfigMock();
    service = new NotificationsService(prisma, config);

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
  // sendTestNotification — phone number fallback logic
  // =========================================================================
  describe('sendTestNotification – phone number fallback', () => {
    it('Scenario A: uses account-scoped dedicated number when found', async () => {
      // First findFirst (savedAccountId = ACCOUNT_ID) returns a phone
      prisma.tenantPhoneNumber.findFirst.mockResolvedValueOnce(mockPhoneRecord);

      const result = await service.sendTestNotification(USER_ID, ACCOUNT_ID, undefined, '+15559999999');

      expect(result.success).toBe(true);
      expect((service as any).sendViaSigcore).toHaveBeenCalled();

      // First call should have been with the account-scoped query
      const firstCallArgs = prisma.tenantPhoneNumber.findFirst.mock.calls[0][0];
      expect(firstCallArgs.where).toMatchObject({ userId: USER_ID, savedAccountId: ACCOUNT_ID, status: 'ACTIVE' });
    });

    it('Scenario B: falls back to null-savedAccountId number when account-scoped returns null', async () => {
      // First findFirst (account-scoped) → null; second (null-scoped) → phone
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockPhoneRecord);

      const result = await service.sendTestNotification(USER_ID, ACCOUNT_ID, undefined, '+15559999999');

      expect(result.success).toBe(true);
      expect((service as any).sendViaSigcore).toHaveBeenCalled();
      expect(prisma.tenantPhoneNumber.findFirst).toHaveBeenCalledTimes(2);

      const secondCallArgs = prisma.tenantPhoneNumber.findFirst.mock.calls[1][0];
      expect(secondCallArgs.where).toMatchObject({ userId: USER_ID, savedAccountId: null, status: 'ACTIVE' });
    });

    it('Scenario C: returns error when both lookups return null', async () => {
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.sendTestNotification(USER_ID, ACCOUNT_ID, undefined, '+15559999999');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No dedicated number assigned. Get a dedicated number first.');
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

    it('Scenario A: uses account-scoped dedicated number when found', async () => {
      prisma.tenantPhoneNumber.findFirst.mockResolvedValueOnce(mockPhoneRecord);

      const result = await service.sendAdHocSms(USER_ID, ACCOUNT_ID, LEAD_ID, MESSAGE);

      expect(result.success).toBe(true);
      expect((service as any).sendViaSigcore).toHaveBeenCalled();

      const firstCallArgs = prisma.tenantPhoneNumber.findFirst.mock.calls[0][0];
      expect(firstCallArgs.where).toMatchObject({ userId: USER_ID, savedAccountId: ACCOUNT_ID, status: 'ACTIVE' });
    });

    it('Scenario B: falls back to null-savedAccountId number when account-scoped returns null', async () => {
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockPhoneRecord);

      const result = await service.sendAdHocSms(USER_ID, ACCOUNT_ID, LEAD_ID, MESSAGE);

      expect(result.success).toBe(true);
      expect((service as any).sendViaSigcore).toHaveBeenCalled();
      expect(prisma.tenantPhoneNumber.findFirst).toHaveBeenCalledTimes(2);

      const secondCallArgs = prisma.tenantPhoneNumber.findFirst.mock.calls[1][0];
      expect(secondCallArgs.where).toMatchObject({ userId: USER_ID, savedAccountId: null, status: 'ACTIVE' });
    });

    it('Scenario C: returns error when both lookups return null', async () => {
      prisma.tenantPhoneNumber.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.sendAdHocSms(USER_ID, ACCOUNT_ID, LEAD_ID, MESSAGE);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No dedicated number assigned. Get a dedicated number first.');
      expect((service as any).sendViaSigcore).not.toHaveBeenCalled();
    });
  });
});
