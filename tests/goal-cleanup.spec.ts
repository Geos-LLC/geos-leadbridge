/**
 * Conversation Goal Cleanup — PR-scoped tests (2026-06-16)
 *
 * Covers the Goal Cleanup PR contract:
 *   1. Phone goal UI label renamed to "Call Handoff". Internal key stays
 *      `phone` so existing followUpStrategy='phone' saved values resolve
 *      unchanged (no DB migration).
 *   2. Booking goal added — schedules the job, asks for preferred date/
 *      time, offers two availability slots when present, does NOT
 *      override a customer price question, hands off if the customer
 *      asks for a phone call.
 *   3. Built-in qualification field `service_date` ("Desired Service
 *      Date") is in the catalog and gates BOTH Qualify and Booking via
 *      buildQualificationBlockForStrategy.
 *   4. Existing goal settings ('hybrid', 'convert', and old 'phone' key)
 *      still resolve in the prompt layer without crashing.
 *
 * These tests intentionally pin to behavior, not implementation detail,
 * so the prompt wording can evolve as long as the contract holds.
 */

import { describe, it, expect } from 'vitest';
import { STRATEGY_PROMPTS, STRATEGY_KEYS } from '../src/ai/strategy-prompts';
import {
  SELECTABLE_GOAL_KEYS,
  SUPPORTED_GOAL_KEYS,
} from '../src/ai/goal-resolver';
import {
  buildQualificationBlock,
  buildQualificationBlockForStrategy,
} from '../src/ai/qualification-context';

// ─── 1. Call Handoff (internal key `phone`) ─────────────────────────────────

describe('Goal Cleanup — Call Handoff (key kept as `phone` for back-compat)', () => {
  it('keeps the internal key `phone` so saved followUpStrategy values do not break', () => {
    expect(STRATEGY_KEYS).toContain('phone');
    expect(STRATEGY_PROMPTS.phone).toBeTruthy();
  });

  it('still surfaces "phone" as a selectable goal in the picker', () => {
    expect(SELECTABLE_GOAL_KEYS).toContain('phone');
  });

  it('the phone prompt is now titled "Call Handoff"', () => {
    expect(STRATEGY_PROMPTS.phone).toMatch(/CALL HANDOFF/i);
  });

  it('Call Handoff still asks for the phone number (Step 2)', () => {
    expect(STRATEGY_PROMPTS.phone).toMatch(/best number to reach you/i);
  });

  it('Call Handoff explicitly stops short of closing the booking in chat', () => {
    // Hand off to the team — don't try to schedule in-chat. This is the
    // line that separates Call Handoff from Booking.
    expect(STRATEGY_PROMPTS.phone).toMatch(/Booking goal/i);
  });
});

// ─── 2. Booking goal ────────────────────────────────────────────────────────

describe('Goal Cleanup — Booking goal', () => {
  it('Booking is a first-class strategy key', () => {
    expect(STRATEGY_KEYS).toContain('booking');
    expect(STRATEGY_PROMPTS.booking).toBeTruthy();
  });

  it('Booking is selectable in the UI picker', () => {
    expect(SELECTABLE_GOAL_KEYS).toContain('booking');
  });

  it('Booking is a supported goal key for the resolver', () => {
    expect(SUPPORTED_GOAL_KEYS).toContain('booking');
  });

  it('Booking asks for preferred service date/time', () => {
    expect(STRATEGY_PROMPTS.booking).toMatch(/preferred service date/i);
  });

  it('Booking offers two slots when an AVAILABILITY block is present', () => {
    // Behavior contract: when concrete slots are known, surface exactly
    // two of them as suggestions instead of asking open-ended.
    expect(STRATEGY_PROMPTS.booking).toContain('AVAILABILITY');
    expect(STRATEGY_PROMPTS.booking).toMatch(/EXACTLY TWO|two of them/i);
  });

  it('Booking does NOT override a customer price question', () => {
    // If the customer asks price first, answer the price question first
    // and only THEN return to asking for the date.
    expect(STRATEGY_PROMPTS.booking).toMatch(/asks about price BEFORE/i);
    expect(STRATEGY_PROMPTS.booking).toMatch(/answer the price question first/i);
  });

  it('Booking hands off when the customer asks for a phone call', () => {
    expect(STRATEGY_PROMPTS.booking).toMatch(/asks for a phone call/i);
    expect(STRATEGY_PROMPTS.booking).toMatch(/hand off/i);
  });

  it('Booking does NOT chain through every Qualify field', () => {
    // The prompt has to explicitly forbid pet / condition / scope-extras
    // style questions and only allow booking-critical ones. Without this
    // guard Booking would devolve into Qualify.
    expect(STRATEGY_PROMPTS.booking).toMatch(/random qualification questions/i);
    expect(STRATEGY_PROMPTS.booking).toMatch(/booking-critical/i);
  });

  it('Booking will not confirm the booking itself (uses holding message)', () => {
    // Same constraint as Convert / Hybrid — we do not have the team's
    // calendar, so AI must not say "you're booked for Thursday". The
    // prompt body wraps the holding phrase across lines so we match with
    // \s+ instead of a literal space.
    expect(STRATEGY_PROMPTS.booking).toMatch(/let me\s+check our timing/i);
  });

  it('Booking receives the REQUIRED FIELDS block', () => {
    // Mirrors Qualify — the Booking prompt cannot evaluate "is one
    // required field missing?" without the block. Without this gate the
    // booking-critical question logic is dead.
    const out = buildQualificationBlockForStrategy('booking', ['zip_code']);
    expect(out).toContain('Zip Code');
  });
});

// ─── 3. Desired Service Date field ──────────────────────────────────────────

describe('Goal Cleanup — Desired Service Date qualification field', () => {
  it('the catalog renders service_date as "Desired Service Date"', () => {
    const out = buildQualificationBlock(['service_date']);
    expect(out).toContain('Desired Service Date');
  });

  it('Qualify (not just Booking) receives the desired-date field when ticked', () => {
    // Spec: this field belongs under Qualify, not only Booking.
    const out = buildQualificationBlockForStrategy('qualify', ['service_date']);
    expect(out).toContain('Desired Service Date');
  });

  it('Booking also receives the desired-date field when ticked', () => {
    const out = buildQualificationBlockForStrategy('booking', ['service_date']);
    expect(out).toContain('Desired Service Date');
  });

  it('co-exists with other required fields in canonical order (sf → service_date → phone)', () => {
    const out = buildQualificationBlock(['phone_number', 'service_date', 'square_footage']);
    const sfIdx = out.indexOf('Square Footage');
    const sdIdx = out.indexOf('Desired Service Date');
    const pnIdx = out.indexOf('Phone Number');
    expect(sfIdx).toBeGreaterThan(-1);
    expect(sdIdx).toBeGreaterThan(sfIdx);
    expect(pnIdx).toBeGreaterThan(sdIdx);
  });
});

// ─── 4. Back-compat for existing goal settings ──────────────────────────────

describe('Goal Cleanup — existing goal settings do not break', () => {
  it('a saved followUpStrategy of "phone" still resolves to a prompt', () => {
    // The user-facing label changed to Call Handoff but the resolver
    // must still find STRATEGY_PROMPTS.phone.
    expect(STRATEGY_PROMPTS.phone).toBeTruthy();
    expect(STRATEGY_PROMPTS.phone.length).toBeGreaterThan(50);
  });

  it('legacy "hybrid" saved value still resolves to a prompt', () => {
    expect(STRATEGY_PROMPTS.hybrid).toBeTruthy();
    expect(SUPPORTED_GOAL_KEYS).toContain('hybrid');
  });

  it('legacy "convert" saved value still resolves to a prompt', () => {
    expect(STRATEGY_PROMPTS.convert).toBeTruthy();
    expect(SUPPORTED_GOAL_KEYS).toContain('convert');
  });

  it('a tenant who saved a Qualify required-fields list with only `phone_number` still gets a valid block', () => {
    // Spec: Qualify with phone only asks phone but continues according
    // to Qualify behavior — i.e. the block lists Phone Number, the
    // prompt still tells the AI to never quote and to ask one field at
    // a time.
    const block = buildQualificationBlockForStrategy('qualify', ['phone_number']);
    expect(block).toContain('Phone Number');
    expect(STRATEGY_PROMPTS.qualify).toMatch(/Never quote/i);
  });

  it('Qualify with desired_date asks for the desired date (it is in the catalog as service_date)', () => {
    // The legacy assumption was that Qualify hardcoded square footage
    // first. With the catalog-driven refactor + this PR, the Desired
    // Service Date field is fully selectable under Qualify.
    const block = buildQualificationBlockForStrategy('qualify', ['service_date']);
    expect(block).toContain('Desired Service Date');
  });

  it('Qualify prompt no longer hardcodes a square-footage-first priority order', () => {
    // The pre-refactor prompt listed sqft as the highest-priority field;
    // the new catalog-driven prompt defers to whatever REQUIRED FIELDS
    // are present. Pin this so the priority block doesn't sneak back in.
    expect(STRATEGY_PROMPTS.qualify).not.toMatch(/Square footage \(highest/i);
  });
});
