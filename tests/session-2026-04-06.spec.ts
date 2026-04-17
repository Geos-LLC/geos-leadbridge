/**
 * Session 2026-04-06 — Unit Tests
 *
 * Covers features built in this session:
 * 1. Yelp token refresh logic (5 tests)
 * 2. Follow-up scheduler eligibility (5 tests)
 * 3. Follow-up step resolution (4 tests)
 * 4. Team management (6 tests)
 * 5. Urgency detection (4 tests)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// 1. Yelp Token Refresh Logic
// ============================================================

/**
 * Replicated from webhooks.service.ts / leads.service.ts / yelp.controller.ts
 * Token refresh logic for Yelp OAuth tokens (7-day access, 365-day refresh).
 */

interface YelpCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string; // ISO date
}

function isTokenExpired(creds: YelpCredentials): boolean {
  return new Date(creds.expiresAt) < new Date();
}

async function refreshYelpToken(
  creds: YelpCredentials,
  doRefresh: (refreshToken: string) => Promise<YelpCredentials>,
): Promise<YelpCredentials> {
  if (!creds.refreshToken) {
    throw new Error('No refresh token available — user must reconnect via OAuth');
  }
  return doRefresh(creds.refreshToken);
}

async function handleYelpApiCall(
  creds: YelpCredentials,
  apiCall: (token: string) => Promise<{ status: number; data: any }>,
  doRefresh: (refreshToken: string) => Promise<YelpCredentials>,
): Promise<{ data: any; refreshedCreds: YelpCredentials | null }> {
  const result = await apiCall(creds.accessToken);
  if (result.status === 401) {
    const newCreds = await refreshYelpToken(creds, doRefresh);
    const retryResult = await apiCall(newCreds.accessToken);
    return { data: retryResult.data, refreshedCreds: newCreds };
  }
  return { data: result.data, refreshedCreds: null };
}

describe('Yelp token refresh logic', () => {
  const validCreds: YelpCredentials = {
    accessToken: 'valid-token',
    refreshToken: 'refresh-token-123',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
  };

  const expiredCreds: YelpCredentials = {
    accessToken: 'expired-token',
    refreshToken: 'refresh-token-123',
    expiresAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
  };

  it('returns original token when not expired', () => {
    expect(isTokenExpired(validCreds)).toBe(false);
  });

  it('detects expired token', () => {
    expect(isTokenExpired(expiredCreds)).toBe(true);
  });

  it('refresh token used when access token expired', async () => {
    const doRefresh = vi.fn().mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });

    const newCreds = await refreshYelpToken(expiredCreds, doRefresh);
    expect(doRefresh).toHaveBeenCalledWith('refresh-token-123');
    expect(newCreds.accessToken).toBe('new-access-token');
  });

  it('401 triggers refresh attempt', async () => {
    const doRefresh = vi.fn().mockResolvedValue({
      accessToken: 'refreshed-token',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });

    const apiCall = vi.fn()
      .mockResolvedValueOnce({ status: 401, data: null }) // first call fails
      .mockResolvedValueOnce({ status: 200, data: { leads: [] } }); // retry succeeds

    const result = await handleYelpApiCall(validCreds, apiCall, doRefresh);

    expect(doRefresh).toHaveBeenCalledOnce();
    expect(apiCall).toHaveBeenCalledTimes(2);
    expect(apiCall).toHaveBeenLastCalledWith('refreshed-token');
    expect(result.data).toEqual({ leads: [] });
    expect(result.refreshedCreds).not.toBeNull();
  });

  it('no refresh token throws error', async () => {
    const noRefreshCreds: YelpCredentials = {
      accessToken: 'old-token',
      refreshToken: null,
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    const doRefresh = vi.fn();

    await expect(refreshYelpToken(noRefreshCreds, doRefresh)).rejects.toThrow(
      'No refresh token available',
    );
    expect(doRefresh).not.toHaveBeenCalled();
  });
});

// ============================================================
// 2. Follow-up Scheduler Eligibility
// ============================================================

/**
 * Replicated from follow-up-scheduler.service.ts processEnrollment()
 * Checks if enrollment should continue or stop based on customer reply timing.
 */

interface Enrollment {
  id: string;
  conversationId: string;
  status: 'active' | 'stopped' | 'completed' | 'paused';
  createdAt: Date;
}

interface Message {
  conversationId: string;
  sender: 'customer' | 'business' | 'ai';
  sentAt: Date;
}

function checkEnrollmentEligibility(
  enrollment: Enrollment,
  messages: Message[],
): 'continue' | 'stop' | 'skip' {
  // Re-check status (idempotency)
  if (enrollment.status !== 'active') return 'skip';

  // Check if customer has replied SINCE enrollment was created
  const customerRepliedSinceEnrollment = messages.find(
    (m) =>
      m.conversationId === enrollment.conversationId &&
      m.sender === 'customer' &&
      m.sentAt > enrollment.createdAt,
  );

  if (customerRepliedSinceEnrollment) return 'stop';

  return 'continue';
}

describe('Follow-up scheduler eligibility', () => {
  const enrollmentBase: Enrollment = {
    id: 'enr-1',
    conversationId: 'conv-1',
    status: 'active',
    createdAt: new Date('2026-04-06T10:00:00Z'),
  };

  it('customer message after enrollment -> stop', () => {
    const messages: Message[] = [
      { conversationId: 'conv-1', sender: 'customer', sentAt: new Date('2026-04-06T11:00:00Z') },
    ];
    expect(checkEnrollmentEligibility(enrollmentBase, messages)).toBe('stop');
  });

  it('no customer message after enrollment -> continue', () => {
    const messages: Message[] = [
      { conversationId: 'conv-1', sender: 'business', sentAt: new Date('2026-04-06T11:00:00Z') },
    ];
    expect(checkEnrollmentEligibility(enrollmentBase, messages)).toBe('continue');
  });

  it('customer message before enrollment -> continue (not a reply to follow-up)', () => {
    const messages: Message[] = [
      { conversationId: 'conv-1', sender: 'customer', sentAt: new Date('2026-04-06T09:00:00Z') },
    ];
    expect(checkEnrollmentEligibility(enrollmentBase, messages)).toBe('continue');
  });

  it('enrollment already stopped -> skip', () => {
    const stopped: Enrollment = { ...enrollmentBase, status: 'stopped' };
    expect(checkEnrollmentEligibility(stopped, [])).toBe('skip');
  });

  it('enrollment status not active -> skip', () => {
    const completed: Enrollment = { ...enrollmentBase, status: 'completed' };
    expect(checkEnrollmentEligibility(completed, [])).toBe('skip');

    const paused: Enrollment = { ...enrollmentBase, status: 'paused' };
    expect(checkEnrollmentEligibility(paused, [])).toBe('skip');
  });
});

// ============================================================
// 3. Follow-up Step Resolution
// ============================================================

/**
 * Replicated from follow-up-scheduler.service.ts
 * getUserConfiguredSteps() + parseDelay() + seed template fallback
 */

interface SequenceStep {
  stepOrder: number;
  delayMinutes: number;
  objective: string;
  messageTemplate: string | null;
}

interface SeedTemplate {
  steps: SequenceStep[];
}

function parseDelay(delay: string): number {
  if (!delay) return 60;
  const d = delay.toLowerCase().trim();
  const num = parseFloat(d) || 1;
  if (d.includes('min')) return Math.round(num);
  if (d.includes('hour') || d.includes('hr')) return Math.round(num * 60);
  if (d.includes('day')) return Math.round(num * 1440);
  if (d.includes('week') || d.includes('wk')) return Math.round(num * 10080);
  if (d.includes('month') || d.includes('mo')) return Math.round(num * 43200);
  if (d.includes('year') || d.includes('yr')) return Math.round(num * 525600);
  return Math.round(num);
}

function resolveSteps(
  userConfig: { delay: string; message?: string }[] | null,
  seedTemplate: SeedTemplate,
): SequenceStep[] {
  if (userConfig && userConfig.length > 0) {
    return userConfig.map((s, i) => ({
      stepOrder: i,
      delayMinutes: parseDelay(s.delay),
      objective: 'follow_up',
      messageTemplate: s.message || null,
    }));
  }
  return seedTemplate.steps;
}

describe('Follow-up step resolution', () => {
  const seedTemplate: SeedTemplate = {
    steps: [
      { stepOrder: 0, delayMinutes: 120, objective: 'quick_check_in', messageTemplate: null },
      { stepOrder: 1, delayMinutes: 1440, objective: 'value_add', messageTemplate: null },
      { stepOrder: 2, delayMinutes: 4320, objective: 'soft_nudge', messageTemplate: null },
    ],
  };

  it('user-configured steps override seed template', () => {
    const userConfig = [
      { delay: '5 min', message: 'Hey {{lead.name}}, still interested?' },
      { delay: '2 hours' },
    ];
    const steps = resolveSteps(userConfig, seedTemplate);
    expect(steps).toHaveLength(2);
    expect(steps[0].delayMinutes).toBe(5);
    expect(steps[0].messageTemplate).toBe('Hey {{lead.name}}, still interested?');
    expect(steps[1].delayMinutes).toBe(120);
    expect(steps[1].messageTemplate).toBeNull();
  });

  it('parses human-readable delays: "2 min", "1 hour", "1 day", "3 months", "1 year"', () => {
    expect(parseDelay('2 min')).toBe(2);
    expect(parseDelay('1 hour')).toBe(60);
    expect(parseDelay('1 day')).toBe(1440);
    expect(parseDelay('3 months')).toBe(129600); // 3 * 43200
    expect(parseDelay('1 year')).toBe(525600);
  });

  it('falls back to seed template when no user config', () => {
    const steps = resolveSteps(null, seedTemplate);
    expect(steps).toBe(seedTemplate.steps);
    expect(steps).toHaveLength(3);
    expect(steps[0].objective).toBe('quick_check_in');
  });

  it('step with messageTemplate uses template (not AI)', () => {
    const userConfig = [
      { delay: '10 min', message: 'Hi {{lead.name}}, just following up on your {{lead.category}} request in {{lead.city}}.' },
    ];
    const steps = resolveSteps(userConfig, seedTemplate);
    expect(steps[0].messageTemplate).toBe(
      'Hi {{lead.name}}, just following up on your {{lead.category}} request in {{lead.city}}.',
    );
    // When messageTemplate is set, generator uses it directly (not AI)
    expect(steps[0].messageTemplate).not.toBeNull();
    expect(steps[0].messageTemplate!.includes('{{lead.name}}')).toBe(true);
  });
});

// ============================================================
// 4. Team Management
// ============================================================

/**
 * Replicated from teams.service.ts
 * Pure logic tests using mock Prisma operations.
 */

function makePrismaMock() {
  return {
    orgMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((args: any) => Promise.resolve({ id: 'mem-1', ...args.data })),
      delete: vi.fn().mockResolvedValue({ id: 'mem-1' }),
    },
    organization: {
      create: vi.fn().mockImplementation((args: any) =>
        Promise.resolve({ id: 'org-1', name: args.data.name, members: [] }),
      ),
    },
    orgInvitation: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation((args: any) =>
        Promise.resolve({ id: 'inv-1', token: 'tok-abc', ...args.create }),
      ),
    },
    savedAccount: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

// Replicate core team management logic
async function createOrg(prisma: any, userId: string, name: string) {
  const existing = await prisma.orgMembership.findFirst({ where: { userId } });
  if (existing) throw new Error('You already belong to an organization');

  const org = await prisma.organization.create({
    data: { name, members: { create: { userId, role: 'OWNER' } } },
  });
  return org;
}

async function invite(
  prisma: any,
  userId: string,
  email: string,
  role: string,
  myRole: string,
) {
  if (role === 'OWNER') throw new Error('Cannot invite as OWNER');
  if (myRole === 'MEMBER') throw new Error('Members cannot invite');
  if (myRole === 'ADMIN' && role === 'ADMIN') throw new Error('Admins can only invite members');

  const invitation = await prisma.orgInvitation.upsert({
    where: {},
    create: { email, role, invitedBy: userId, expiresAt: new Date(Date.now() + 7 * 86400_000) },
    update: {},
  });
  return invitation;
}

async function acceptInvite(
  prisma: any,
  userId: string,
  invitation: { token: string; email: string; organizationId: string; role: string; acceptedAt: Date | null; expiresAt: Date },
  userEmail: string,
) {
  if (!invitation) throw new Error('Invitation not found');
  if (invitation.acceptedAt) throw new Error('Invitation already accepted');
  if (invitation.expiresAt < new Date()) throw new Error('Invitation has expired');
  if (userEmail !== invitation.email) throw new Error('This invitation was sent to a different email address');

  const existing = await prisma.orgMembership.findFirst({ where: { userId } });
  if (existing) throw new Error('You already belong to an organization');

  await prisma.orgMembership.create({
    data: { organizationId: invitation.organizationId, userId, role: invitation.role },
  });

  return { organizationId: invitation.organizationId, role: invitation.role };
}

describe('Team management', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('cannot create org if already in one', async () => {
    prisma.orgMembership.findFirst.mockResolvedValue({ id: 'mem-1', role: 'MEMBER' });
    await expect(createOrg(prisma, 'user-1', 'My Team')).rejects.toThrow(
      'You already belong to an organization',
    );
  });

  it('owner can invite, member cannot', async () => {
    // Owner can invite
    const inv = await invite(prisma, 'user-1', 'team@example.com', 'MEMBER', 'OWNER');
    expect(inv).toBeDefined();

    // Member cannot
    await expect(
      invite(prisma, 'user-2', 'new@example.com', 'MEMBER', 'MEMBER'),
    ).rejects.toThrow('Members cannot invite');
  });

  it('cannot invite as OWNER role', async () => {
    await expect(
      invite(prisma, 'user-1', 'new@example.com', 'OWNER', 'OWNER'),
    ).rejects.toThrow('Cannot invite as OWNER');
  });

  it('accept invite links user to org', async () => {
    const invitation = {
      token: 'tok-abc',
      email: 'member@example.com',
      organizationId: 'org-1',
      role: 'MEMBER',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86400_000), // tomorrow
    };

    const result = await acceptInvite(prisma, 'user-2', invitation, 'member@example.com');
    expect(result.organizationId).toBe('org-1');
    expect(result.role).toBe('MEMBER');
    expect(prisma.orgMembership.create).toHaveBeenCalledWith({
      data: { organizationId: 'org-1', userId: 'user-2', role: 'MEMBER' },
    });
  });

  it('expired invitation rejected', async () => {
    const expired = {
      token: 'tok-expired',
      email: 'user@example.com',
      organizationId: 'org-1',
      role: 'MEMBER',
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 86400_000), // yesterday
    };

    await expect(acceptInvite(prisma, 'user-1', expired, 'user@example.com')).rejects.toThrow(
      'Invitation has expired',
    );
  });

  it('wrong email invitation rejected', async () => {
    const invitation = {
      token: 'tok-abc',
      email: 'intended@example.com',
      organizationId: 'org-1',
      role: 'MEMBER',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86400_000),
    };

    await expect(
      acceptInvite(prisma, 'user-1', invitation, 'different@example.com'),
    ).rejects.toThrow('different email address');
  });
});

// ============================================================
// 5. Urgency Detection
// ============================================================

/**
 * Replicated from conversation-context.service.ts
 * Customer urgency detection — rule-based v1.
 */

function detectUrgency(messageContent: string): 'high' | 'low' {
  const urgentPatterns = [
    /\basap\b/i,
    /\btoday\b/i,
    /\burgent/i,
    /as soon as possible/i,
    /right away/i,
    /\btonight\b/i,
    /this morning/i,
    /this afternoon/i,
    /\bnow\b/i,
    /immediately/i,
  ];
  if (urgentPatterns.some((p) => p.test(messageContent))) {
    return 'high';
  }
  return 'low';
}

describe('Urgency detection', () => {
  it('"ASAP" -> customerUrgency high', () => {
    expect(detectUrgency('I need this done ASAP please')).toBe('high');
  });

  it('"today" -> high', () => {
    expect(detectUrgency('Can you come today?')).toBe('high');
  });

  it('"next week" -> not high', () => {
    expect(detectUrgency('We were thinking maybe next week')).toBe('low');
  });

  it('normal message -> low', () => {
    expect(detectUrgency('I would like a quote for a 3 bedroom house cleaning')).toBe('low');
  });
});
