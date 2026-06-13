/**
 * V2 AI Conversation Review Mode — ConversationRuntimeService suggestion
 * helpers + automation.service source-level contract.
 *
 * Three layers covered here:
 *   1. set/get/clear AiSuggestion against an in-memory prisma mock so the
 *      stateJson merge + dedup parsing + clear logic are pinned without
 *      DB round-trips.
 *   2. Source-level grep against automation.service.ts to confirm the
 *      suggest-mode fork is wired in BOTH places it needs to be:
 *        - handleCustomerReply dedup gate + deliveryMode propagation
 *        - executePendingMessage fork right before leadsService.sendMessage
 *      (Full end-to-end coverage of handleCustomerReply gates lives in
 *      automation.service.spec.ts where the constructor mocks are already
 *      maintained — adding the suggest-mode behavior to that spec is the
 *      MVP; the structural pins below catch regression even if mock
 *      maintenance lags.)
 *   3. Source-level grep against leads.controller.ts to pin the three
 *      approval endpoints + the leadsService.sendMessage('ai') call site.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ConversationRuntimeService } from './conversation-runtime.service';

function buildPrismaMock(opts: { stateJson?: string | null; updateCount?: number } = {}) {
  const update = jest.fn().mockResolvedValue({ count: opts.updateCount ?? 1 });
  const findUnique = jest.fn().mockResolvedValue({ stateJson: opts.stateJson ?? null });
  const prisma = {
    threadContext: {
      findUnique,
      updateMany: update,
    },
  } as any;
  return { prisma, update, findUnique };
}

describe('ConversationRuntimeService — AI suggestion helpers', () => {
  describe('setAiSuggestion', () => {
    it('writes a new pendingAiSuggestion into empty stateJson', async () => {
      const { prisma, update } = buildPrismaMock({ stateJson: null });
      const svc = new ConversationRuntimeService(prisma);
      await svc.setAiSuggestion('thread-1', {
        id: 'sugg-1',
        message: 'Hi Sam, thanks for reaching out — when works for you?',
        goal: 'qualify',
        sourceMessageId: 'msg-99',
      });
      expect(update).toHaveBeenCalledTimes(1);
      const dataArg = update.mock.calls[0][0].data;
      const parsed = JSON.parse(dataArg.stateJson);
      expect(parsed.pendingAiSuggestion).toMatchObject({
        id: 'sugg-1',
        message: 'Hi Sam, thanks for reaching out — when works for you?',
        goal: 'qualify',
        reason: 'customer_reply',
        sourceMessageId: 'msg-99',
        status: 'pending',
      });
      expect(typeof parsed.pendingAiSuggestion.createdAt).toBe('string');
    });

    it('merges into existing stateJson — never wipes priceDiscussed et al', async () => {
      const existing = JSON.stringify({
        priceDiscussed: true,
        priceRange: '$210-230',
        lastQuestionAsked: 'When would you like the cleaning done?',
      });
      const { prisma, update } = buildPrismaMock({ stateJson: existing });
      const svc = new ConversationRuntimeService(prisma);
      await svc.setAiSuggestion('thread-1', {
        id: 'sugg-2',
        message: 'OK — Thursday morning works for us.',
      });
      const parsed = JSON.parse(update.mock.calls[0][0].data.stateJson);
      expect(parsed.priceDiscussed).toBe(true);
      expect(parsed.priceRange).toBe('$210-230');
      expect(parsed.lastQuestionAsked).toBe('When would you like the cleaning done?');
      expect(parsed.pendingAiSuggestion.id).toBe('sugg-2');
    });

    it('null conversationId is a no-op (no prisma call)', async () => {
      const { prisma, update } = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setAiSuggestion(null, { id: 'x', message: 'x' });
      expect(update).not.toHaveBeenCalled();
    });

    it('swallows prisma errors so caller never crashes the AI path', async () => {
      const prisma = {
        threadContext: {
          findUnique: jest.fn().mockResolvedValue({ stateJson: null }),
          updateMany: jest.fn().mockRejectedValue(new Error('DB went away')),
        },
      } as any;
      const svc = new ConversationRuntimeService(prisma);
      await expect(
        svc.setAiSuggestion('thread-1', { id: 's', message: 'm' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getAiSuggestion', () => {
    it('returns null when stateJson has no pendingAiSuggestion key', async () => {
      const { prisma } = buildPrismaMock({ stateJson: JSON.stringify({ priceDiscussed: true }) });
      const svc = new ConversationRuntimeService(prisma);
      const out = await svc.getAiSuggestion('thread-1');
      expect(out).toBeNull();
    });

    it('returns the parsed suggestion with normalized fields', async () => {
      const stateJson = JSON.stringify({
        priceDiscussed: true,
        pendingAiSuggestion: {
          id: 'sugg-7',
          message: 'Hi Sam — about how big is the home?',
          goal: 'qualify',
          reason: 'customer_reply',
          sourceMessageId: 'msg-42',
          createdAt: '2026-06-12T18:00:00.000Z',
          status: 'pending',
        },
      });
      const { prisma } = buildPrismaMock({ stateJson });
      const svc = new ConversationRuntimeService(prisma);
      const out = await svc.getAiSuggestion('thread-1');
      expect(out).toEqual({
        id: 'sugg-7',
        message: 'Hi Sam — about how big is the home?',
        goal: 'qualify',
        reason: 'customer_reply',
        sourceMessageId: 'msg-42',
        createdAt: '2026-06-12T18:00:00.000Z',
        status: 'pending',
      });
    });

    it('returns null when stateJson is malformed JSON', async () => {
      const { prisma } = buildPrismaMock({ stateJson: 'not-json-at-all' });
      const svc = new ConversationRuntimeService(prisma);
      const out = await svc.getAiSuggestion('thread-1');
      expect(out).toBeNull();
    });

    it('returns null when pendingAiSuggestion lacks an id or message', async () => {
      const { prisma } = buildPrismaMock({
        stateJson: JSON.stringify({ pendingAiSuggestion: { message: 'no id' } }),
      });
      const svc = new ConversationRuntimeService(prisma);
      expect(await svc.getAiSuggestion('thread-1')).toBeNull();
    });

    it('null conversationId returns null without a prisma call', async () => {
      const { prisma, findUnique } = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      expect(await svc.getAiSuggestion(null)).toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('clearAiSuggestion', () => {
    it('removes the pendingAiSuggestion key and preserves sibling state', async () => {
      const stateJson = JSON.stringify({
        priceDiscussed: true,
        priceRange: '$210-230',
        pendingAiSuggestion: { id: 's', message: 'm', status: 'pending' },
      });
      const { prisma, update } = buildPrismaMock({ stateJson });
      const svc = new ConversationRuntimeService(prisma);
      await svc.clearAiSuggestion('thread-1');
      expect(update).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(update.mock.calls[0][0].data.stateJson);
      expect(parsed.pendingAiSuggestion).toBeUndefined();
      expect(parsed.priceDiscussed).toBe(true);
      expect(parsed.priceRange).toBe('$210-230');
    });

    it('is a no-op when there is no pending suggestion to clear', async () => {
      const { prisma, update } = buildPrismaMock({
        stateJson: JSON.stringify({ priceDiscussed: true }),
      });
      const svc = new ConversationRuntimeService(prisma);
      await svc.clearAiSuggestion('thread-1');
      expect(update).not.toHaveBeenCalled();
    });

    it('is a no-op when stateJson is null', async () => {
      const { prisma, update } = buildPrismaMock({ stateJson: null });
      const svc = new ConversationRuntimeService(prisma);
      await svc.clearAiSuggestion('thread-1');
      expect(update).not.toHaveBeenCalled();
    });

    it('null conversationId is a no-op', async () => {
      const { prisma, findUnique, update } = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.clearAiSuggestion(null);
      expect(findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });
});

describe('V2 Review Mode wiring — automation.service.ts source contract', () => {
  const source = readFileSync(
    join(__dirname, '..', 'automation', 'automation.service.ts'),
    'utf-8',
  );

  it('handleCustomerReply reads aiRules.aiConversationDeliveryMode', () => {
    expect(source).toMatch(
      /aiRules\s*as\s*any\s*\)\.aiConversationDeliveryMode\s*===\s*['"]suggest['"]/,
    );
  });

  it('handleCustomerReply dedup gate calls getAiSuggestion before scheduling', () => {
    // The dedup gate has to sit BEFORE the synthetic-rule construction;
    // otherwise we'd queue a generation that executePendingMessage would
    // immediately bounce.
    const dedupIdx = source.search(/AI_SUGGEST\][\s\S]*dedup/);
    const scheduleIdx = source.search(/await this\.scheduleAutomatedMessage\(syntheticRule/);
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeLessThan(scheduleIdx);
  });

  it('synthetic AI rule carries deliveryMode through to executePendingMessage', () => {
    // The rule literal must include `deliveryMode: aiConversationDeliveryMode`
    // so executePendingMessage can fork on it without re-reading account JSON.
    expect(source).toMatch(/deliveryMode:\s*aiConversationDeliveryMode/);
  });

  it('executePendingMessage forks on rule.deliveryMode === "suggest" BEFORE sendMessage', () => {
    // Find both anchors and assert ordering — the suggest branch parks
    // and returns; the send line must come AFTER and only run when the
    // branch fell through.
    const suggestForkIdx = source.search(
      /\(rule as any\)\.deliveryMode\s*===\s*['"]suggest['"]/,
    );
    const sendIdx = source.search(/await this\.leadsService\.sendMessage\(/);
    expect(suggestForkIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(suggestForkIdx).toBeLessThan(sendIdx);
  });

  it('suggest fork calls conversationRuntime.setAiSuggestion + returns without sending', () => {
    const start = source.search(/\(rule as any\)\.deliveryMode\s*===\s*['"]suggest['"]/);
    expect(start).toBeGreaterThan(-1);
    // 1200 chars is enough to cover the whole branch body.
    const branch = source.slice(start, start + 1200);
    expect(branch).toMatch(/setAiSuggestion\(/);
    expect(branch).toMatch(/\breturn;/);
    // Make sure the branch does NOT contain a sendMessage call.
    expect(branch).not.toMatch(/leadsService\.sendMessage/);
  });

  it('suggest fork resolves sourceMessageId for dedup against next customer reply', () => {
    const start = source.search(/\(rule as any\)\.deliveryMode\s*===\s*['"]suggest['"]/);
    const branch = source.slice(start, start + 1200);
    expect(branch).toMatch(/sourceMessageId/);
    expect(branch).toMatch(/message\.findFirst[\s\S]{0,200}sender:\s*['"]customer['"]/);
  });
});

describe('V2 Review Mode wiring — leads.controller.ts endpoint contract', () => {
  const source = readFileSync(
    join(__dirname, '..', 'leads', 'leads.controller.ts'),
    'utf-8',
  );

  it('declares GET :id/ai-suggestion endpoint', () => {
    expect(source).toMatch(/@Get\(['"]:id\/ai-suggestion['"]\)/);
  });

  it('declares POST :id/ai-suggestion/send endpoint', () => {
    expect(source).toMatch(/@Post\(['"]:id\/ai-suggestion\/send['"]\)/);
  });

  it('declares POST :id/ai-suggestion/discard endpoint', () => {
    expect(source).toMatch(/@Post\(['"]:id\/ai-suggestion\/discard['"]\)/);
  });

  it('send endpoint dispatches via leadsService.sendMessage with senderType="ai"', () => {
    // The send endpoint must use the same dispatch path the auto-send mode
    // uses, with the 'ai' sender tag so downstream observability + handoff
    // freshness behave identically.
    const sendBlock = source.match(/@Post\(['"]:id\/ai-suggestion\/send['"]\)[\s\S]{0,1500}/);
    expect(sendBlock).toBeTruthy();
    expect(sendBlock![0]).toMatch(/leadsService\.sendMessage\([^)]+,\s*['"]ai['"]\)/);
  });

  it('send endpoint clears the suggestion AFTER successful dispatch', () => {
    const sendBlock = source.match(/@Post\(['"]:id\/ai-suggestion\/send['"]\)[\s\S]{0,1500}/);
    expect(sendBlock).toBeTruthy();
    const block = sendBlock![0];
    const sendIdx = block.search(/leadsService\.sendMessage/);
    const clearIdx = block.search(/clearAiSuggestion/);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(sendIdx);
  });

  it('discard endpoint clears the suggestion + never calls sendMessage', () => {
    const discardBlock = source.match(/@Post\(['"]:id\/ai-suggestion\/discard['"]\)[\s\S]{0,800}/);
    expect(discardBlock).toBeTruthy();
    const block = discardBlock![0];
    expect(block).toMatch(/clearAiSuggestion/);
    expect(block).not.toMatch(/leadsService\.sendMessage/);
  });

  it('send endpoint supports an optional body override for Edit & Send', () => {
    const sendBlock = source.match(/@Post\(['"]:id\/ai-suggestion\/send['"]\)[\s\S]{0,1500}/);
    expect(sendBlock).toBeTruthy();
    expect(sendBlock![0]).toMatch(/overrideMessage|@Body\(['"]message['"]\)/);
  });

  it('all three endpoints verify lead ownership via { id, userId } prisma filter', () => {
    // Scope tenancy check — prisma.lead.findFirst({ where: { id, userId } })
    // is the established pattern on this controller. Pin it so a future
    // edit doesn't drop the userId clause and leak across tenants.
    const aiSuggestionBlocks = source.match(/ai-suggestion[\s\S]{0,1800}/g) || [];
    expect(aiSuggestionBlocks.length).toBeGreaterThan(0);
    for (const block of aiSuggestionBlocks) {
      expect(block).toMatch(/where:\s*\{\s*id,\s*userId:\s*user\.id\s*\}/);
    }
  });
});
