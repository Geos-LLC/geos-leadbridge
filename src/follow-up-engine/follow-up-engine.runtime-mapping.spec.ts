import { mapStopReasonToRuntime } from './follow-up-engine.service';

describe('mapStopReasonToRuntime', () => {
  it.each([
    ['classifier_opt_out',           { aiStatus: 'stopped_terminal',  conversationState: 'opted_out' }],
    ['classifier_hired_elsewhere',   { aiStatus: 'stopped_terminal',  conversationState: 'hired_elsewhere' }],
    ['classifier_completed',         { aiStatus: 'stopped_terminal',  conversationState: 'hired_elsewhere' }],
    ['classifier_agreed',            { aiStatus: 'stopped_booked',    conversationState: 'booked_in_lb' }],
    // wants_live_contact pauses the AI (handoff pending) — does NOT stop it as
    // "booked" (no booking happened yet). stopped_booked stays reserved for
    // classifier_agreed and SF service_scheduled. Fixed 2026-06-11.
    ['classifier_wants_live_contact',{ aiStatus: 'paused_human',      conversationState: 'human_handling' }],
    ['classifier_deferring',         { aiStatus: 'paused_deferral',   conversationState: 'deferred' }],
    // 'manual' = operator/dispatcher reply happened. After their reply we
    // are waiting for the CUSTOMER, hence awaiting_customer. Reserved
    // human_handling for the pre-reply state ("customer wants live contact,
    // no human reply yet"). Fixed 2026-06-08 — bad TC values were leaving
    // ~30% of "Human Handoff" badges stale on the inbox.
    ['manual',                       { aiStatus: 'paused_human',      conversationState: 'awaiting_customer' }],
  ])('maps reason %s correctly', (reason, expected) => {
    const r = mapStopReasonToRuntime(reason);
    expect(r).not.toBeNull();
    expect(r!.aiStatus).toBe(expected.aiStatus);
    expect(r!.conversationState).toBe(expected.conversationState);
  });

  it('customer_replied → conversationState only, no aiStatus change', () => {
    const r = mapStopReasonToRuntime('customer_replied');
    expect(r).not.toBeNull();
    expect(r!.conversationState).toBe('customer_replied');
    expect(r!.aiStatus).toBeUndefined();
  });

  it.each([
    'sf_status_completed',
    'sf_status_cancelled',
    'sf_status_no_show',
  ])('sf_status_* (%s) → stopped_terminal with CRM_TERMINAL_LEGACY reason', (reason) => {
    const r = mapStopReasonToRuntime(reason);
    expect(r).not.toBeNull();
    expect(r!.aiStatus).toBe('stopped_terminal');
    expect(r!.aiStatusReason).toBe('crm_terminal_status_legacy');
    expect(r!.conversationStateReason).toBe('sf_terminal');
  });

  it.each([
    'lead_status_done',
    'lead_status_scheduled',
    'lead_status_archived',
  ])('lead_status_* (%s) → stopped_terminal with CRM_TERMINAL_LEGACY reason', (reason) => {
    const r = mapStopReasonToRuntime(reason);
    expect(r).not.toBeNull();
    expect(r!.aiStatus).toBe('stopped_terminal');
    expect(r!.aiStatusReason).toBe('crm_terminal_status_legacy');
  });

  it.each([
    ['',                  null],
    ['unknown_reason',    null],
    ['random_text',       null],
  ])('unknown reason %s → null (do not invent state)', (reason, expected) => {
    expect(mapStopReasonToRuntime(reason as string)).toBe(expected);
  });

  it('is case-insensitive', () => {
    const r = mapStopReasonToRuntime('CLASSIFIER_OPT_OUT');
    expect(r).not.toBeNull();
    expect(r!.aiStatus).toBe('stopped_terminal');
  });
});
