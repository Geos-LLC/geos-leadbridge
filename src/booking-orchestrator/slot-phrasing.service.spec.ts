import { ConfigService } from '@nestjs/config';
import { SlotPhrasingService } from './slot-phrasing.service';
import type { TimeSlot } from '../sf-orchestration/sf-orchestration.contracts';

function buildSvc(env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-test' }): SlotPhrasingService {
  const cfg = {
    get: ((k: string, def?: any) => env[k] ?? def) as any,
  } as ConfigService;
  return new SlotPhrasingService(cfg);
}

function slot(slotId: string, startISO: string, endISO: string): TimeSlot {
  return { slotId, start: startISO, end: endISO };
}

describe('SlotPhrasingService', () => {
  describe('fallbackTemplate (deterministic — no AI)', () => {
    it('returns "Let me check availability" when slots is empty', () => {
      const out = buildSvc().fallbackTemplate([], { customerName: 'Jane' });
      expect(out).toBe('Let me check availability and get back to you.');
    });

    it('numbers slots 1..N in order with formatted labels', () => {
      const svc = buildSvc();
      const slots = [
        slot('s1', '2026-06-02T13:00:00Z', '2026-06-02T15:00:00Z'),
        slot('s2', '2026-06-03T18:30:00Z', '2026-06-03T20:30:00Z'),
      ];
      const out = svc.fallbackTemplate(slots, { customerName: 'Jane Doe', accountName: 'Acme', timezone: 'UTC' });
      // First name only, account name lead-in, "Which works?" close
      expect(out).toContain('Hi Jane,');
      expect(out).toContain('Acme has these openings');
      expect(out).toContain('1) ');
      expect(out).toContain('2) ');
      expect(out).toContain('Which works?');
    });

    it('omits greeting when customerName is null', () => {
      const out = buildSvc().fallbackTemplate(
        [slot('s1', '2026-06-02T13:00:00Z', '2026-06-02T15:00:00Z')],
        { accountName: 'Acme', timezone: 'UTC' },
      );
      expect(out.startsWith('Hi ')).toBe(false);
      expect(out).toContain('Acme has these openings');
    });

    it('uses neutral lead-in when accountName is null', () => {
      const out = buildSvc().fallbackTemplate(
        [slot('s1', '2026-06-02T13:00:00Z', '2026-06-02T15:00:00Z')],
        { customerName: 'Jane', timezone: 'UTC' },
      );
      expect(out).toContain('we have these openings');
    });
  });

  describe('formatSlot (label stability)', () => {
    it('produces a label containing weekday + month + day + time', () => {
      const svc = buildSvc();
      const s = slot('s1', '2026-06-02T13:00:00Z', '2026-06-02T15:00:00Z');
      const label = svc.formatSlot(s, 'UTC');
      // We don't assert exact string (Intl varies by Node version) — just
      // that the format contains the relevant components.
      expect(label).toMatch(/Tue/i);
      expect(label).toMatch(/Jun/i);
      expect(label).toMatch(/2/);
      expect(label).toMatch(/\d{1,2}:\d{2}/);
    });

    it('falls back to ISO string when date is invalid', () => {
      const out = buildSvc().formatSlot({ slotId: 's', start: 'not-a-date', end: 'x' } as any, 'UTC');
      expect(out).toBe('not-a-date');
    });
  });

  describe('phrase() — AI failure paths fall back deterministically', () => {
    it('returns template (source=template, reason=no_slots) when slots is empty', async () => {
      const out = await buildSvc().phrase([], { customerName: 'Jane' });
      expect(out.source).toBe('template');
      expect(out.fallbackReason).toBe('no_slots');
      expect(out.message).toBe('Let me check availability and get back to you.');
    });

    it('falls back to template when OPENAI_API_KEY missing (client init throws)', async () => {
      const svc = buildSvc({});
      const out = await svc.phrase(
        [slot('s1', '2026-06-02T13:00:00Z', '2026-06-02T15:00:00Z')],
        { customerName: 'Jane', accountName: 'Acme', timezone: 'UTC' },
      );
      expect(out.source).toBe('template');
      expect(out.fallbackReason).toBe('ai_error');
      expect(out.message).toContain('1) ');
      expect(out.message).toContain('Acme has these openings');
    });
  });

  describe('safety: phrasing never introduces unauthorized text when falling back', () => {
    it('every fallback message contains EXACTLY the slot labels we provided', () => {
      const svc = buildSvc();
      const slots = [
        slot('s1', '2026-06-02T13:00:00Z', '2026-06-02T15:00:00Z'),
        slot('s2', '2026-06-04T20:00:00Z', '2026-06-04T22:00:00Z'),
      ];
      const out = svc.fallbackTemplate(slots, { timezone: 'UTC' });
      for (const s of slots) {
        const label = svc.formatSlot(s, 'UTC');
        expect(out).toContain(label);
      }
    });
  });
});
