/**
 * Conversation runtime state vocabulary — Phase 1.
 *
 * These string sets are the durable replacement for state we used to infer
 * by re-reading Lead.status, Message.senderType recency windows, and
 * ephemeral classifier outputs. They live on `ThreadContext` (per-conversation)
 * so the UI and downstream services can read state directly without
 * re-deriving it.
 *
 * Phase 1 only WRITES these fields in parallel with the existing logic.
 * Phase 3 will replace the legacy decision points with reads against them.
 */

export const CONVERSATION_STATES = [
  'new',                // lead just arrived, no business response yet
  'ai_engaging',        // AI has actively replied; awaiting customer
  'awaiting_customer',  // any outbound (AI or human) sent; awaiting customer
  'customer_replied',   // customer replied; not yet classified or routed
  'human_handling',     // handoff fired OR manual reply inside pause window
  'deferred',           // classifier=deferring; check-in scheduled
  'opted_out',          // classifier=opt_out (high confidence)
  'hired_elsewhere',    // classifier=hired_elsewhere / customer hired competitor
  'booked_in_lb',       // classifier=agreed — LB-side booking signal
  'long_silent',        // derived: no customer message > N days (not written today)
  'closed',             // operator-archived
] as const;

export type ConversationState = typeof CONVERSATION_STATES[number];

export const AI_STATUSES = [
  'disabled',           // User.aiConversationEnabled = false
  'active',             // eligible to reply on next inbound
  'paused_human',       // manual reply landed inside recency window
  'paused_deferral',    // classifier=deferring; pause until check-in
  'stopped_terminal',   // classifier=opt_out / hired_elsewhere
  'stopped_booked',     // classifier=agreed (post-handoff)
  'unavailable',        // outside business hours when mode=when_dispatcher_unavailable
] as const;

export type AiStatus = typeof AI_STATUSES[number];

/**
 * Standard reason tags for aiStatus writes. Free-form strings allowed at
 * runtime; this enum is the canonical taxonomy so logs/dashboards stay
 * greppable.
 */
export const AI_STATUS_REASONS = {
  USER_DISABLED: 'user_ai_conversation_disabled',
  OUTSIDE_BUSINESS_HOURS: 'outside_business_hours',
  MANUAL_REPLY_WINDOW: 'manual_reply_recency_window',
  CLASSIFIER_OPT_OUT: 'classifier_opt_out',
  CLASSIFIER_HIRED_ELSEWHERE: 'classifier_hired_elsewhere',
  CLASSIFIER_AGREED: 'classifier_agreed',
  CLASSIFIER_WANTS_LIVE_CONTACT: 'classifier_wants_live_contact',
  CLASSIFIER_DEFERRING: 'classifier_deferring',
  CRM_TERMINAL_LEGACY: 'crm_terminal_status_legacy',
  AI_REPLY_SENT: 'ai_reply_sent',
  AI_REPLY_SCHEDULED: 'ai_reply_scheduled',
} as const;

export const CONVERSATION_STATE_REASONS = {
  AI_REPLIED: 'ai_replied',
  MANUAL_REPLY: 'manual_reply',
  CUSTOMER_REPLIED: 'customer_replied',
  HANDOFF_FIRED: 'handoff_fired',
  CLASSIFIER_OPT_OUT: 'classifier_opt_out',
  CLASSIFIER_HIRED_ELSEWHERE: 'classifier_hired_elsewhere',
  CLASSIFIER_AGREED: 'classifier_agreed',
  CLASSIFIER_WANTS_LIVE_CONTACT: 'classifier_wants_live_contact',
  CLASSIFIER_DEFERRING: 'classifier_deferring',
  SF_TERMINAL: 'sf_terminal',
  CRM_TERMINAL_LEGACY: 'crm_terminal_status_legacy',
} as const;

export function isConversationState(s: string | null | undefined): s is ConversationState {
  if (!s) return false;
  return (CONVERSATION_STATES as readonly string[]).includes(s);
}

export function isAiStatus(s: string | null | undefined): s is AiStatus {
  if (!s) return false;
  return (AI_STATUSES as readonly string[]).includes(s);
}
