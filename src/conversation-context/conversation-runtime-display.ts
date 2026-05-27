/**
 * Display-label helpers for the conversation runtime layer.
 *
 * Pure mapping functions, no DB access. Used by the runtime-state +
 * legacy-comparison endpoints so the future UI can render human-readable
 * pill labels without re-implementing the vocabulary client-side.
 *
 * Keep labels short (≤25 chars) and product-focused — operators, not engineers.
 */

import type { ConversationState, AiStatus } from './conversation-runtime';

const CONVERSATION_STATE_LABELS: Record<string, string> = {
  new: 'New',
  ai_engaging: 'AI engaging',
  awaiting_customer: 'Awaiting customer',
  customer_replied: 'Customer replied',
  human_handling: 'Human handling',
  deferred: 'Deferred',
  opted_out: 'Opted out',
  hired_elsewhere: 'Hired elsewhere',
  booked_in_lb: 'Booked',
  long_silent: 'Long silent',
  closed: 'Closed',
};

const AI_STATUS_LABELS: Record<string, string> = {
  disabled: 'AI disabled',
  active: 'AI active',
  paused_human: 'AI paused — human',
  paused_deferral: 'AI paused — deferral',
  stopped_terminal: 'AI stopped — terminal',
  stopped_booked: 'AI stopped — booked',
  unavailable: 'AI unavailable',
};

const CLASSIFIER_INTENT_LABELS: Record<string, string> = {
  engaged: 'Engaged',
  asking: 'Asking question',
  agreed: 'Ready to book',
  wants_live_contact: 'Wants live contact',
  provided_phone_number: 'Provided phone',
  provided_square_footage: 'Provided sqft',
  qualification_complete: 'Qualification done',
  deferring: 'Deferring',
  opt_out: 'Opted out',
  hired_elsewhere: 'Hired elsewhere',
  completed: 'Says completed',
  terminal_defer: 'Long-term defer',
};

const SF_JOB_OUTCOME_LABELS: Record<string, string> = {
  pending: 'SF: pending',
  confirmed: 'SF: confirmed',
  scheduled: 'SF: scheduled',
  rescheduled: 'SF: rescheduled',
  in_progress: 'SF: in progress',
  completed: 'SF: completed',
  cancelled: 'SF: cancelled',
  no_show: 'SF: no-show',
  archived: 'SF: archived',
  lost: 'SF: lost',
};

export function labelConversationState(state: string | null | undefined): string {
  if (!state) return '—';
  return CONVERSATION_STATE_LABELS[state] ?? state;
}

export function labelAiStatus(status: string | null | undefined): string {
  if (!status) return '—';
  return AI_STATUS_LABELS[status] ?? status;
}

export function labelClassifierIntent(intent: string | null | undefined): string {
  if (!intent) return '—';
  return CLASSIFIER_INTENT_LABELS[intent] ?? intent;
}

export function labelSfJobOutcome(outcome: string | null | undefined): string {
  if (!outcome) return '—';
  return SF_JOB_OUTCOME_LABELS[outcome] ?? outcome;
}

export function labelFollowUp(
  status: string | null | undefined,
  nextAt: Date | null | undefined,
): string {
  if (!status || status === 'none') return 'No follow-up';
  if (status === 'active' && nextAt) {
    const ms = nextAt.getTime() - Date.now();
    if (ms <= 0) return 'Follow-up due now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `Follow-up in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `Follow-up in ${hours}h`;
    const days = Math.round(hours / 24);
    return `Follow-up in ${days}d`;
  }
  if (status === 'paused') return 'Follow-up paused';
  if (status === 'completed') return 'Follow-up completed';
  if (status === 'stopped') return 'Follow-up stopped';
  if (status === 'suggested') return 'Follow-up suggested';
  if (status === 'sent') return 'Follow-up sent';
  return status;
}

export function labelHandoff(
  requestedAt: Date | null | undefined,
  resolvedAt: Date | null | undefined,
): string {
  if (!requestedAt) return 'No handoff';
  if (resolvedAt) return 'Handoff resolved';
  return 'Handoff requested';
}
