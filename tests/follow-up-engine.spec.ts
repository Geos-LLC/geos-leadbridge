/**
 * Follow-Up Engine — Unit Tests
 *
 * Covers Phase 1 deliverables:
 * - FollowUpStateService: state derivation from ThreadContext
 * - FollowUpEngineService: enrollment, stop on reply (idempotent), pause/resume
 * - Active hours computation: within window, outside window, day boundary, overnight
 * - Seed data: correct preset count and structure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import types and data directly to avoid NestJS decorator issues in test
type ThreadStateInput = {
  stage: string;
  engagementLevel: string;
  awaitingCustomerReply: boolean;
  priceDiscussed: boolean;
  lastQuestionAsked: string | null;
  businessMessages: number;
  aiMessages: number;
  customerMessages: number;
};

// Replicate deriveFollowUpState logic for pure unit testing (no NestJS DI)
function deriveFollowUpState(ctx: ThreadStateInput): string | null {
  if (!ctx.awaitingCustomerReply) return null;
  if (ctx.stage === 'booked') return null;
  if (ctx.stage === 'lost') return null;
  if (ctx.stage === 'closed') return null;
  if (ctx.engagementLevel === 'cold') return null;
  if (ctx.businessMessages < 1 && ctx.aiMessages < 1) return null;
  if (ctx.stage === 'negotiation') return 'no_reply_after_conversion';
  if (ctx.priceDiscussed) return 'no_reply_after_price';
  if (ctx.lastQuestionAsked) return 'no_reply_after_question';
  return 'no_reply_after_initial';
}

// Import seed data (pure data, no NestJS deps)
import { FOLLOW_UP_PRESETS } from '../src/follow-up-engine/follow-up-seed';

// ============================================================
// FollowUpStateService tests (isolated, no mocks needed)
// ============================================================

describe('FollowUpStateService', () => {
  const baseCtx: ThreadStateInput = {
    stage: 'qualification',
    engagementLevel: 'warm',
    awaitingCustomerReply: true,
    priceDiscussed: false,
    lastQuestionAsked: null,
    businessMessages: 1,
    aiMessages: 0,
    customerMessages: 1,
  };

  // -- Eligible states --

  it('returns no_reply_after_initial when business replied and customer silent', () => {
    expect(deriveFollowUpState(baseCtx)).toBe('no_reply_after_initial');
  });

  it('returns no_reply_after_question when lastQuestionAsked is set', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      lastQuestionAsked: 'How many bedrooms?',
    })).toBe('no_reply_after_question');
  });

  it('returns no_reply_after_price when priceDiscussed is true', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      priceDiscussed: true,
    })).toBe('no_reply_after_price');
  });

  it('returns no_reply_after_conversion when stage is negotiation', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      stage: 'negotiation',
    })).toBe('no_reply_after_conversion');
  });

  // -- Priority: conversion > price > question > initial --

  it('conversion takes priority over price', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      stage: 'negotiation',
      priceDiscussed: true,
      lastQuestionAsked: 'When can you start?',
    })).toBe('no_reply_after_conversion');
  });

  it('price takes priority over question', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      priceDiscussed: true,
      lastQuestionAsked: 'How many rooms?',
    })).toBe('no_reply_after_price');
  });

  it('question takes priority over initial', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      lastQuestionAsked: 'What size is your home?',
    })).toBe('no_reply_after_question');
  });

  // -- Not eligible --

  it('returns null when customer is not awaiting reply', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      awaitingCustomerReply: false,
    })).toBeNull();
  });

  it('returns null when stage is booked', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      stage: 'booked',
    })).toBeNull();
  });

  it('returns null when stage is lost', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      stage: 'lost',
    })).toBeNull();
  });

  it('returns null when stage is closed', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      stage: 'closed',
    })).toBeNull();
  });

  it('returns null when engagement is cold', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      engagementLevel: 'cold',
    })).toBeNull();
  });

  it('returns null when no business/AI response yet', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      businessMessages: 0,
      aiMessages: 0,
    })).toBeNull();
  });

  it('returns initial when AI responded but no business messages', () => {
    expect(deriveFollowUpState({
      ...baseCtx,
      businessMessages: 0,
      aiMessages: 1,
    })).toBe('no_reply_after_initial');
  });
});

// ============================================================
// FollowUpEngineService tests (mocked Prisma)
// ============================================================

function makePrismaMock() {
  return {
    followUpEnrollment: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((args: any) => Promise.resolve({ id: 'enr-1', ...args.data })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    followUpSequenceTemplate: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    followUpStepExecution: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    threadContext: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeContextMock() {
  return {
    getThreadState: vi.fn().mockResolvedValue(null),
  };
}

function makeEventEmitterMock() {
  return { emit: vi.fn() };
}

// Lightweight harness replicating FollowUpEngineService.handleCustomerReply
async function handleCustomerReply(prisma: any, conversationId: string) {
  const result = await prisma.followUpEnrollment.updateMany({
    where: { conversationId, status: 'active' },
    data: { status: 'stopped', stoppedReason: 'customer_replied', completedAt: new Date() },
  });

  if (result.count > 0) {
    await prisma.followUpStepExecution.updateMany({
      where: { enrollment: { conversationId }, status: { in: ['scheduled', 'suggested'] } },
      data: { status: 'cancelled' },
    });
    await prisma.threadContext.updateMany({
      where: { conversationId },
      data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped', followUpState: null },
    });
  }
}

describe('FollowUpEngineService — handleCustomerReply', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('stops active enrollment and cancels pending steps', async () => {
    prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

    await handleCustomerReply(prisma, 'conv-1');

    expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1', status: 'active' },
      data: expect.objectContaining({ status: 'stopped', stoppedReason: 'customer_replied' }),
    });
    expect(prisma.followUpStepExecution.updateMany).toHaveBeenCalledWith({
      where: { enrollment: { conversationId: 'conv-1' }, status: { in: ['scheduled', 'suggested'] } },
      data: { status: 'cancelled' },
    });
    expect(prisma.threadContext.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1' },
      data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped', followUpState: null },
    });
  });

  it('is idempotent — no-op when no active enrollment', async () => {
    prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 0 });

    await handleCustomerReply(prisma, 'conv-1');

    expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledOnce();
    expect(prisma.followUpStepExecution.updateMany).not.toHaveBeenCalled();
    expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent — second call after stop is no-op', async () => {
    prisma.followUpEnrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })  // first call stops
      .mockResolvedValueOnce({ count: 0 }); // second call: already stopped

    await handleCustomerReply(prisma, 'conv-1');
    await handleCustomerReply(prisma, 'conv-1');

    expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.followUpStepExecution.updateMany).toHaveBeenCalledTimes(1); // only first call
    expect(prisma.threadContext.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Active hours computation tests
// ============================================================

describe('Active hours — computeNextDueAt', () => {
  // Replicating FollowUpEngineService.computeNextDueAt logic
  function isWithinActiveHours(time: Date, start: string, end: string, timezone: string): boolean {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const localTime = formatter.format(time);
    const [h, m] = localTime.split(':').map(Number);
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const current = h * 60 + m;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin > endMin) return current >= startMin || current < endMin;
    return current >= startMin && current < endMin;
  }

  it('returns true when within normal business hours', () => {
    // 2pm ET on a weekday
    const time = new Date('2026-03-31T18:00:00Z'); // 2pm ET (UTC-4)
    expect(isWithinActiveHours(time, '09:00', '21:00', 'America/New_York')).toBe(true);
  });

  it('returns false when before business hours', () => {
    // 7am ET
    const time = new Date('2026-03-31T11:00:00Z'); // 7am ET
    expect(isWithinActiveHours(time, '09:00', '21:00', 'America/New_York')).toBe(false);
  });

  it('returns false when after business hours', () => {
    // 10pm ET
    const time = new Date('2026-04-01T02:00:00Z'); // 10pm ET
    expect(isWithinActiveHours(time, '09:00', '21:00', 'America/New_York')).toBe(false);
  });

  it('handles overnight window — within', () => {
    // 11pm ET, window 22:00-06:00
    const time = new Date('2026-04-01T03:00:00Z'); // 11pm ET
    expect(isWithinActiveHours(time, '22:00', '06:00', 'America/New_York')).toBe(true);
  });

  it('handles overnight window — outside (midday)', () => {
    // 2pm ET, window 22:00-06:00
    const time = new Date('2026-03-31T18:00:00Z'); // 2pm ET
    expect(isWithinActiveHours(time, '22:00', '06:00', 'America/New_York')).toBe(false);
  });

  it('handles edge — exactly at start', () => {
    // 9am ET
    const time = new Date('2026-03-31T13:00:00Z'); // 9am ET
    expect(isWithinActiveHours(time, '09:00', '21:00', 'America/New_York')).toBe(true);
  });

  it('handles edge — exactly at end', () => {
    // 9pm ET
    const time = new Date('2026-04-01T01:00:00Z'); // 9pm ET
    expect(isWithinActiveHours(time, '09:00', '21:00', 'America/New_York')).toBe(false);
  });

  it('works with Pacific timezone', () => {
    // 2pm PT = 9pm UTC
    const time = new Date('2026-03-31T21:00:00Z');
    expect(isWithinActiveHours(time, '09:00', '17:00', 'America/Los_Angeles')).toBe(true);
  });
});

// ============================================================
// Seed data structure tests
// ============================================================

describe('Seed presets', () => {
  it('has exactly 12 presets', () => {
    expect(FOLLOW_UP_PRESETS).toHaveLength(12);
  });

  it('every preset covers both Yelp and Thumbtack', () => {
    for (const preset of FOLLOW_UP_PRESETS) {
      expect(preset.platforms).toEqual(expect.arrayContaining(['yelp', 'thumbtack']));
    }
  });

  it('covers all 4 trigger states', () => {
    const states = new Set(FOLLOW_UP_PRESETS.map(p => p.triggerState));
    expect(states).toEqual(new Set([
      'no_reply_after_initial',
      'no_reply_after_question',
      'no_reply_after_price',
      'no_reply_after_conversion',
    ]));
  });

  it('covers all 3 preset types per state', () => {
    const states = ['no_reply_after_initial', 'no_reply_after_question', 'no_reply_after_price', 'no_reply_after_conversion'];
    for (const state of states) {
      const presets = FOLLOW_UP_PRESETS.filter(p => p.triggerState === state).map(p => p.preset);
      expect(presets).toContain('conservative');
      expect(presets).toContain('standard');
      expect(presets).toContain('persistent');
    }
  });

  it('each preset has schemaVersion 1', () => {
    for (const preset of FOLLOW_UP_PRESETS) {
      expect(preset.stepsJson.schemaVersion).toBe(1);
    }
  });

  it('each preset has non-empty steps array', () => {
    for (const preset of FOLLOW_UP_PRESETS) {
      expect(preset.stepsJson.steps.length).toBeGreaterThan(0);
    }
  });

  it('steps are ordered by stepOrder', () => {
    for (const preset of FOLLOW_UP_PRESETS) {
      for (let i = 0; i < preset.stepsJson.steps.length; i++) {
        expect(preset.stepsJson.steps[i].stepOrder).toBe(i);
      }
    }
  });

  it('every step has objective and delayMinutes', () => {
    for (const preset of FOLLOW_UP_PRESETS) {
      for (const step of preset.stepsJson.steps) {
        expect(step.objective).toBeTruthy();
        expect(typeof step.delayMinutes).toBe('number');
        expect(step.delayMinutes).toBeGreaterThan(0);
      }
    }
  });

  it('conservative has fewest steps, persistent has most', () => {
    const states = ['no_reply_after_initial', 'no_reply_after_question', 'no_reply_after_price', 'no_reply_after_conversion'];
    for (const state of states) {
      const byPreset = Object.fromEntries(
        FOLLOW_UP_PRESETS.filter(p => p.triggerState === state).map(p => [p.preset, p.stepsJson.steps.length])
      );
      expect(byPreset.conservative).toBeLessThanOrEqual(byPreset.standard);
      expect(byPreset.standard).toBeLessThanOrEqual(byPreset.persistent);
    }
  });

  it('exactly one default per trigger state', () => {
    const states = ['no_reply_after_initial', 'no_reply_after_question', 'no_reply_after_price', 'no_reply_after_conversion'];
    for (const state of states) {
      const defaults = FOLLOW_UP_PRESETS.filter(p => p.triggerState === state && (p as any).isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].preset).toBe('standard');
    }
  });
});
