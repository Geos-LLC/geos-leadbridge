/**
 * AppointmentDetectorService — unit tests.
 *
 * Covers:
 *   - preFilter rejects messages without date+time+keyword (no LLM call)
 *   - preFilter accepts messages with all three signals
 *   - LLM result parsing (confirmed, appointmentAt, slotMinutes, confidence)
 *   - Confidence threshold: confirmed=true must clear MIN_CONFIDENCE
 *   - LLM errors / empty responses degrade gracefully (confirmed=false)
 *   - Invalid appointmentAt strings are rejected even when LLM claims confirmed
 */

import { ConfigService } from '@nestjs/config';
import { AppointmentDetectorService } from './appointment-detector.service';

type MockChatCreate = jest.Mock;

function makeService(mockCreate: MockChatCreate): AppointmentDetectorService {
  const cfg = { get: () => 'sk-test' } as unknown as ConfigService;
  const svc = new AppointmentDetectorService(cfg);
  Object.defineProperty(svc, 'client', {
    get: () => ({
      chat: { completions: { create: mockCreate } },
    }),
  });
  return svc;
}

function llmReply(payload: Record<string, unknown>): MockChatCreate {
  return jest.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
}

const CONFIRMATION = `Hi Lanita, This is a friendly reminder that your house cleaning appointment is scheduled for tomorrow June 25 between 10-10:30 AM. Our cleaner will arrive on time tomorrow.`;

describe('AppointmentDetectorService.preFilter', () => {
  it('passes a typical dispatcher confirmation', () => {
    expect(AppointmentDetectorService.preFilter(CONFIRMATION)).toBe(true);
  });

  it('rejects messages with no time token', () => {
    const msg = `Hi Lanita, your appointment is scheduled for tomorrow June 25. Let us know if anything has changed.`;
    expect(AppointmentDetectorService.preFilter(msg)).toBe(false);
  });

  it('rejects messages with no date token', () => {
    const msg = `Hi Lanita, your appointment is scheduled at 10:30 AM. Our cleaner will arrive on time.`;
    expect(AppointmentDetectorService.preFilter(msg)).toBe(false);
  });

  it('rejects an FAQ / pricing reply', () => {
    const msg = `Hi! Our standard deep clean is $200 for up to 3 bedrooms — let me know if you'd like to book.`;
    expect(AppointmentDetectorService.preFilter(msg)).toBe(false);
  });

  it('rejects a "let me check" holding reply', () => {
    const msg = `Let me check the calendar and get back to you shortly.`;
    expect(AppointmentDetectorService.preFilter(msg)).toBe(false);
  });

  it('rejects empty / whitespace input', () => {
    expect(AppointmentDetectorService.preFilter('')).toBe(false);
    expect(AppointmentDetectorService.preFilter('   ')).toBe(false);
  });
});

describe('AppointmentDetectorService.detect', () => {
  const baseInput = {
    messageSentAt: new Date('2026-06-24T17:00:00Z'),
    timezone: 'America/New_York',
    customerName: 'Lanita',
  };

  it('short-circuits when the pre-filter rejects (no LLM call)', async () => {
    const create = jest.fn();
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: 'Got it, thanks!' });
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ confirmed: false, skippedByPrefilter: true, reason: 'prefilter_no_match' });
  });

  it('returns confirmed=true when LLM confirms with high confidence', async () => {
    const create = llmReply({
      confirmed: true,
      appointmentAt: '2026-06-25T14:00:00Z',
      slotMinutes: 30,
      confidence: 0.95,
      reason: 'reminder + concrete date/time/range',
    });
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.confirmed).toBe(true);
    expect(result.appointmentAt).toBe('2026-06-25T14:00:00.000Z');
    expect(result.slotMinutes).toBe(30);
    expect(result.confidence).toBe(0.95);
    expect(result.skippedByPrefilter).toBe(false);
  });

  it('drops a confirmation below the confidence threshold', async () => {
    const create = llmReply({
      confirmed: true,
      appointmentAt: '2026-06-25T14:00:00Z',
      slotMinutes: 30,
      confidence: 0.7,
      reason: 'ambiguous',
    });
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe('low_confidence');
  });

  it('treats LLM confirmed=true with invalid appointmentAt as not confirmed', async () => {
    const create = llmReply({
      confirmed: true,
      appointmentAt: 'not-a-date',
      slotMinutes: 30,
      confidence: 0.95,
      reason: 'bad iso',
    });
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe('invalid_appointment_at');
  });

  it('returns confirmed=false when LLM says confirmed=false', async () => {
    const create = llmReply({
      confirmed: false,
      appointmentAt: null,
      slotMinutes: null,
      confidence: 0.4,
      reason: 'pricing reply, not a confirmation',
    });
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.confirmed).toBe(false);
    expect(result.appointmentAt).toBeNull();
  });

  it('degrades to confirmed=false on LLM error', async () => {
    const create = jest.fn().mockRejectedValue(new Error('boom'));
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain('llm_error');
    expect(result.skippedByPrefilter).toBe(false);
  });

  it('clamps confidence to [0, 1]', async () => {
    const create = llmReply({
      confirmed: true,
      appointmentAt: '2026-06-25T14:00:00Z',
      slotMinutes: 30,
      confidence: 1.5,
      reason: 'over-clamped',
    });
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.confidence).toBe(1);
  });

  it('rejects implausible slotMinutes', async () => {
    const create = llmReply({
      confirmed: true,
      appointmentAt: '2026-06-25T14:00:00Z',
      slotMinutes: 9999,
      confidence: 0.95,
      reason: 'huge slot',
    });
    const svc = makeService(create);
    const result = await svc.detect({ ...baseInput, messageText: CONFIRMATION });
    expect(result.slotMinutes).toBeNull();
  });
});
