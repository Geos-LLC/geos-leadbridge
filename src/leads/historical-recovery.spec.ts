import {
  isHistoricalMarketplaceRecovery,
  getReactivationDeliveryBlocker,
  HISTORICAL_RECOVERY_DISPLAY_LABEL,
  HISTORICAL_RECOVERY_INTERNAL_TRIGGER_STATE,
} from './historical-recovery';

describe('isHistoricalMarketplaceRecovery', () => {
  const base = {
    status: 'engaged',
    lostReason: null,
    statusSource: null,
    thumbtackStatus: null,
    platformStatus: null,
    sfJobId: null,
    sfCustomerId: null,
    syncStatus: null,
  };

  describe('match clause A — PR 4 backfill tag', () => {
    it('matches when statusSource=backfill_pr4_v1 on a non-disqualified lead', () => {
      expect(isHistoricalMarketplaceRecovery({ ...base, statusSource: 'backfill_pr4_v1' })).toBe(true);
    });

    it('matches even when thumbtackStatus is neutral (Open/null)', () => {
      expect(isHistoricalMarketplaceRecovery({ ...base, statusSource: 'backfill_pr4_v1', thumbtackStatus: 'Open' })).toBe(true);
      expect(isHistoricalMarketplaceRecovery({ ...base, statusSource: 'backfill_pr4_v1', thumbtackStatus: null })).toBe(true);
    });
  });

  describe('match clause B — marketplace terminal outcome', () => {
    it.each([
      'No hire', 'no_hire', 'Not hired', 'not_hired',
      'Hired someone else', 'hired_someone_else',
      'Closed', 'Archived', 'Job done', 'job_done', 'Done',
    ])('matches thumbtackStatus="%s"', (ts) => {
      expect(isHistoricalMarketplaceRecovery({ ...base, thumbtackStatus: ts })).toBe(true);
    });

    it('matches platformStatus when thumbtackStatus is null (Yelp path)', () => {
      expect(isHistoricalMarketplaceRecovery({ ...base, platformStatus: 'No hire' })).toBe(true);
    });

    it('does not match neutral or unmapped marketplace statuses', () => {
      expect(isHistoricalMarketplaceRecovery({ ...base, thumbtackStatus: 'Open' })).toBe(false);
      expect(isHistoricalMarketplaceRecovery({ ...base, thumbtackStatus: 'Not scheduled yet' })).toBe(false);
    });
  });

  describe('disqualifiers', () => {
    it.each(['cancelled', 'booked', 'scheduled', 'completed'])(
      'rejects lead with Lead.status=%s even when PR 4 tag is present',
      (status) => {
        expect(isHistoricalMarketplaceRecovery({
          ...base, status, statusSource: 'backfill_pr4_v1',
        })).toBe(false);
      },
    );

    it('rejects opt_out leads regardless of source', () => {
      expect(isHistoricalMarketplaceRecovery({
        ...base, lostReason: 'opt_out', statusSource: 'backfill_pr4_v1',
      })).toBe(false);
      expect(isHistoricalMarketplaceRecovery({
        ...base, lostReason: 'opt_out', thumbtackStatus: 'No hire',
      })).toBe(false);
    });

    it.each([
      { sfJobId: 'job_123' },
      { sfCustomerId: 'cust_456' },
      { syncStatus: 'linked' },
    ])('rejects SF-linked lead (%o) even when match clauses fire', (sf) => {
      expect(isHistoricalMarketplaceRecovery({
        ...base, statusSource: 'backfill_pr4_v1', ...sf,
      })).toBe(false);
    });
  });

  describe('neither clause matches', () => {
    it('returns false when both source and marketplace outcome are neutral', () => {
      expect(isHistoricalMarketplaceRecovery({ ...base })).toBe(false);
    });

    it('returns false for a fresh active negotiation', () => {
      expect(isHistoricalMarketplaceRecovery({
        ...base, status: 'engaged', thumbtackStatus: 'Open',
      })).toBe(false);
    });
  });
});

describe('getReactivationDeliveryBlocker', () => {
  const baseTT = {
    threadId: 'conv-1',
    platform: 'thumbtack',
    customerPhone: null,
    customerPhoneSubstitute: null,
    thumbtackStatus: 'No hire',
    platformStatus: 'No hire',
    conversationState: null,
    lastCustomerMessageContent: null,
  };

  it('1. SMS-only platform + no phone + no platform channel → no_delivery_channel', () => {
    expect(getReactivationDeliveryBlocker({
      ...baseTT, platform: 'sms_only', customerPhone: null, customerPhoneSubstitute: null,
    })).toBe('no_delivery_channel');
  });

  it('1b. TT lead with no phone is STILL deliverable via the platform thread', () => {
    // Gail Counter shape: no phone, TT thread exists, "No hire" status → not skipped here.
    // The actual TT 404 happens at send time; this predicate is pre-activation only.
    expect(getReactivationDeliveryBlocker({
      ...baseTT, customerPhone: null, customerPhoneSubstitute: null, platform: 'thumbtack',
    })).toBeNull();
  });

  it('2. thumbtackStatus="Closed" → platform_thread_closed', () => {
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: 'Closed' })).toBe('platform_thread_closed');
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: 'closed' })).toBe('platform_thread_closed');
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: null, platformStatus: 'Closed' })).toBe('platform_thread_closed');
  });

  it('3. thumbtackStatus="Archived" → platform_thread_archived', () => {
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: 'Archived' })).toBe('platform_thread_archived');
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: null, platformStatus: 'archived' })).toBe('platform_thread_archived');
  });

  it('4. "No hire" is the target cohort — does NOT trigger any skip', () => {
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: 'No hire' })).toBeNull();
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: 'no hire' })).toBeNull();
    expect(getReactivationDeliveryBlocker({ ...baseTT, thumbtackStatus: 'Not hired' })).toBeNull();
    expect(getReactivationDeliveryBlocker({ ...baseTT, platformStatus: 'No hire' })).toBeNull();
  });

  it('5. valid phone + open platform status → null (deliverable)', () => {
    expect(getReactivationDeliveryBlocker({
      ...baseTT, customerPhone: '5551234567', thumbtackStatus: 'Open', platformStatus: 'Open',
    })).toBeNull();
  });

  it('5b. customerPhoneSubstitute is treated as a deliverable phone', () => {
    expect(getReactivationDeliveryBlocker({
      ...baseTT, platform: 'sms_only', customerPhone: null, customerPhoneSubstitute: '5559876543',
    })).toBeNull();
  });

  it('no threadId → no_thread_id (gate 0)', () => {
    expect(getReactivationDeliveryBlocker({ ...baseTT, threadId: null })).toBe('no_thread_id');
  });

  it('conversationState=customer_replied → awaiting_human_response', () => {
    expect(getReactivationDeliveryBlocker({ ...baseTT, conversationState: 'customer_replied' })).toBe('awaiting_human_response');
  });

  it('conversationState=human_handling → awaiting_human_response', () => {
    expect(getReactivationDeliveryBlocker({ ...baseTT, conversationState: 'human_handling' })).toBe('awaiting_human_response');
  });

  it('deferral phrase in last customer message → deferral_phrase', () => {
    expect(getReactivationDeliveryBlocker({
      ...baseTT, lastCustomerMessageContent: "Let me check with my husband and I'll get back to you",
    })).toBe('deferral_phrase');
  });

  it('ordering: structural skips (no threadId) run before content checks', () => {
    // A row that has BOTH no threadId AND a deferral phrase reports no_thread_id —
    // the cheaper, more definitive skip wins.
    expect(getReactivationDeliveryBlocker({
      ...baseTT, threadId: null, lastCustomerMessageContent: 'let me check',
    })).toBe('no_thread_id');
  });

  it('ordering: closed status runs before deferral check', () => {
    expect(getReactivationDeliveryBlocker({
      ...baseTT, thumbtackStatus: 'Closed', lastCustomerMessageContent: 'let me check',
    })).toBe('platform_thread_closed');
  });
});

describe('Historical Recovery constants', () => {
  it('exposes the user-facing display label', () => {
    expect(HISTORICAL_RECOVERY_DISPLAY_LABEL).toBe('Historical Lead Reactivation');
  });

  it('reuses customer_hired_competitor as the internal trigger state', () => {
    expect(HISTORICAL_RECOVERY_INTERNAL_TRIGGER_STATE).toBe('customer_hired_competitor');
  });
});
