import { deriveRuntime } from './backfill-conversation-runtime';

const base = {
  conversationId: 'conv-1',
  awaitingCustomerReply: false,
  lastCustomerMessageAt: null,
  lastBusinessMessageAt: null,
  lastAiMessageAt: null,
  followUpStatus: null,
  leadStatus: null,
  lostReason: null,
  statusSource: null,
};

describe('deriveRuntime (backfill)', () => {
  describe('strong terminal signals (Lead.status + lostReason)', () => {
    it('lost + opt_out → opted_out + stopped_terminal', () => {
      const r = deriveRuntime({ ...base, leadStatus: 'lost', lostReason: 'opt_out' });
      expect(r.conversationState).toBe('opted_out');
      expect(r.aiStatus).toBe('stopped_terminal');
      expect(r.conversationStateReason).toContain('opt_out');
    });

    it('lost + hired_someone → hired_elsewhere + stopped_terminal', () => {
      const r = deriveRuntime({ ...base, leadStatus: 'lost', lostReason: 'hired_someone' });
      expect(r.conversationState).toBe('hired_elsewhere');
      expect(r.aiStatus).toBe('stopped_terminal');
    });

    it('lost without specific lostReason → leaves both null (do not invent)', () => {
      const r = deriveRuntime({ ...base, leadStatus: 'lost', lostReason: 'no_response' });
      expect(r.conversationState).toBeNull();
      expect(r.aiStatus).toBeNull();
    });

    it('booked → booked_in_lb + stopped_booked', () => {
      const r = deriveRuntime({ ...base, leadStatus: 'booked' });
      expect(r.conversationState).toBe('booked_in_lb');
      expect(r.aiStatus).toBe('stopped_booked');
    });

    it('archived → closed (no aiStatus — could be any prior reason)', () => {
      const r = deriveRuntime({ ...base, leadStatus: 'archived' });
      expect(r.conversationState).toBe('closed');
      expect(r.aiStatus).toBeNull();
    });
  });

  describe('awaiting/engaging signals', () => {
    it('awaiting + last msg AI → ai_engaging', () => {
      const lastAi = new Date('2026-05-25T10:00:00Z');
      const lastBiz = new Date('2026-05-25T09:00:00Z');
      const r = deriveRuntime({
        ...base,
        awaitingCustomerReply: true,
        lastAiMessageAt: lastAi,
        lastBusinessMessageAt: lastBiz,
      });
      expect(r.conversationState).toBe('ai_engaging');
    });

    it('awaiting + last msg business → awaiting_customer', () => {
      const lastAi = new Date('2026-05-25T09:00:00Z');
      const lastBiz = new Date('2026-05-25T10:00:00Z');
      const r = deriveRuntime({
        ...base,
        awaitingCustomerReply: true,
        lastAiMessageAt: lastAi,
        lastBusinessMessageAt: lastBiz,
      });
      expect(r.conversationState).toBe('awaiting_customer');
    });

    it('not awaiting + customer last spoke → customer_replied', () => {
      const r = deriveRuntime({
        ...base,
        awaitingCustomerReply: false,
        lastCustomerMessageAt: new Date('2026-05-25T10:00:00Z'),
      });
      expect(r.conversationState).toBe('customer_replied');
    });

    it('awaiting after follow-up sent → awaiting_customer', () => {
      const r = deriveRuntime({
        ...base,
        awaitingCustomerReply: true,
        followUpStatus: 'sent',
      });
      expect(r.conversationState).toBe('awaiting_customer');
    });
  });

  describe('waitingSince derivation', () => {
    it('uses most recent pro message when awaiting', () => {
      const lastAi = new Date('2026-05-25T10:00:00Z');
      const lastBiz = new Date('2026-05-25T09:00:00Z');
      const r = deriveRuntime({
        ...base,
        awaitingCustomerReply: true,
        lastAiMessageAt: lastAi,
        lastBusinessMessageAt: lastBiz,
      });
      expect(r.waitingSince).toEqual(lastAi);
    });

    it('null when not awaiting', () => {
      const r = deriveRuntime({
        ...base,
        awaitingCustomerReply: false,
        lastBusinessMessageAt: new Date('2026-05-25T09:00:00Z'),
      });
      expect(r.waitingSince).toBeNull();
    });

    it('null when awaiting but no pro messages ever sent', () => {
      const r = deriveRuntime({ ...base, awaitingCustomerReply: true });
      expect(r.waitingSince).toBeNull();
    });
  });

  describe('uncertain cases → all null (do not invent)', () => {
    it('completely empty input', () => {
      const r = deriveRuntime(base);
      expect(r.conversationState).toBeNull();
      expect(r.aiStatus).toBeNull();
      expect(r.waitingSince).toBeNull();
    });

    it('non-terminal Lead.status with no other signals', () => {
      const r = deriveRuntime({ ...base, leadStatus: 'new' });
      expect(r.conversationState).toBeNull();
      expect(r.aiStatus).toBeNull();
    });

    it('not awaiting + no customer message ever → null', () => {
      const r = deriveRuntime({ ...base, awaitingCustomerReply: false });
      expect(r.conversationState).toBeNull();
    });
  });

  describe('idempotency invariant', () => {
    // The backfill skips rows where any new column is already non-null.
    // This is enforced by the WHERE clause in updateMany — the pure function
    // itself doesn't know about prior state. But the function must be
    // deterministic so running it twice on the same input yields the same
    // output (verified by snapshot here).
    it('is deterministic for the same input', () => {
      const input = {
        ...base,
        awaitingCustomerReply: true,
        lastAiMessageAt: new Date('2026-05-25T10:00:00Z'),
        leadStatus: 'lost',
        lostReason: 'opt_out',
      };
      const a = deriveRuntime(input);
      const b = deriveRuntime(input);
      expect(a.conversationState).toBe(b.conversationState);
      expect(a.aiStatus).toBe(b.aiStatus);
    });
  });
});
