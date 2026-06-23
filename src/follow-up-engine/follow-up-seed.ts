/**
 * Follow-Up Seed Data
 *
 * 12 preset templates: 4 trigger states × 3 presets (conservative, standard, persistent).
 * Each preset applies to one or more platforms via the `platforms` array — the seed
 * loop creates one DB row per (preset × requested-platform) match.
 *
 * Each step has an objective (not a hardcoded message).
 * AI generates actual text from objective + ThreadContext.
 */

export const FOLLOW_UP_PRESETS = [
  // ==========================================
  // no_reply_after_initial
  // ==========================================
  {
    name: 'Conservative — After Initial Reply',
    triggerState: 'no_reply_after_initial',
    preset: 'conservative',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 60, objective: 'quick_check_in' },
        { stepOrder: 1, delayMinutes: 1440, objective: 'value_add' },
        { stepOrder: 2, delayMinutes: 4320, objective: 'soft_close' },
      ],
    },
  },
  {
    name: 'Standard — After Initial Reply',
    triggerState: 'no_reply_after_initial',
    preset: 'standard',
    platforms: ['yelp', 'thumbtack'],
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' },
        { stepOrder: 1, delayMinutes: 10, objective: 'value_add' },
        { stepOrder: 2, delayMinutes: 60, objective: 'soft_nudge' },
        { stepOrder: 3, delayMinutes: 1440, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 4320, objective: 'last_chance' },
        { stepOrder: 5, delayMinutes: 10080, objective: 'monthly_check' },
        { stepOrder: 6, delayMinutes: 20160, objective: 'monthly_check' },
        { stepOrder: 7, delayMinutes: 43200, objective: 'monthly_check' },
        { stepOrder: 8, delayMinutes: 131400, objective: 'monthly_check' },
        { stepOrder: 9, delayMinutes: 262800, objective: 'final_attempt' },
        { stepOrder: 10, delayMinutes: 525600, objective: 'final_attempt' },
      ],
    },
  },
  {
    name: 'Persistent — After Initial Reply',
    triggerState: 'no_reply_after_initial',
    preset: 'persistent',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' },
        { stepOrder: 1, delayMinutes: 10, objective: 'value_add' },
        { stepOrder: 2, delayMinutes: 60, objective: 'soft_nudge' },
        { stepOrder: 3, delayMinutes: 1440, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 4320, objective: 'last_chance' },
        { stepOrder: 5, delayMinutes: 10080, objective: 'monthly_check' },
        { stepOrder: 6, delayMinutes: 20160, objective: 'monthly_check' },
        { stepOrder: 7, delayMinutes: 43200, objective: 'final_attempt' },
      ],
    },
  },

  // ==========================================
  // no_reply_after_question
  // ==========================================
  {
    name: 'Conservative — After Question',
    triggerState: 'no_reply_after_question',
    preset: 'conservative',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 30, objective: 'clarification_reminder' },
        { stepOrder: 1, delayMinutes: 240, objective: 'value_add' },
        { stepOrder: 2, delayMinutes: 1440, objective: 'soft_close' },
      ],
    },
  },
  {
    name: 'Standard — After Question',
    triggerState: 'no_reply_after_question',
    preset: 'standard',
    platforms: ['yelp', 'thumbtack'],
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 5, objective: 'clarification_reminder' },
        { stepOrder: 1, delayMinutes: 30, objective: 'simplified_question' },
        { stepOrder: 2, delayMinutes: 120, objective: 'value_add' },
        { stepOrder: 3, delayMinutes: 1440, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 4320, objective: 'last_chance' },
      ],
    },
  },
  {
    name: 'Persistent — After Question',
    triggerState: 'no_reply_after_question',
    preset: 'persistent',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 5, objective: 'clarification_reminder' },
        { stepOrder: 1, delayMinutes: 30, objective: 'simplified_question' },
        { stepOrder: 2, delayMinutes: 120, objective: 'value_add' },
        { stepOrder: 3, delayMinutes: 1440, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 4320, objective: 'last_chance' },
        { stepOrder: 5, delayMinutes: 10080, objective: 'monthly_check' },
        { stepOrder: 6, delayMinutes: 20160, objective: 'monthly_check' },
      ],
    },
  },

  // ==========================================
  // no_reply_after_price
  // ==========================================
  {
    name: 'Conservative — After Price',
    triggerState: 'no_reply_after_price',
    preset: 'conservative',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 120, objective: 'price_follow_up' },
        { stepOrder: 1, delayMinutes: 1440, objective: 'value_justification' },
        { stepOrder: 2, delayMinutes: 4320, objective: 'soft_close' },
      ],
    },
  },
  {
    name: 'Standard — After Price',
    triggerState: 'no_reply_after_price',
    preset: 'standard',
    platforms: ['yelp', 'thumbtack'],
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 30, objective: 'price_follow_up' },
        { stepOrder: 1, delayMinutes: 120, objective: 'value_justification' },
        { stepOrder: 2, delayMinutes: 1440, objective: 'flexibility_offer' },
        { stepOrder: 3, delayMinutes: 4320, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 10080, objective: 'last_chance' },
      ],
    },
  },
  {
    name: 'Persistent — After Price',
    triggerState: 'no_reply_after_price',
    preset: 'persistent',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 30, objective: 'price_follow_up' },
        { stepOrder: 1, delayMinutes: 120, objective: 'value_justification' },
        { stepOrder: 2, delayMinutes: 1440, objective: 'flexibility_offer' },
        { stepOrder: 3, delayMinutes: 4320, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 10080, objective: 'last_chance' },
        { stepOrder: 5, delayMinutes: 20160, objective: 'monthly_check' },
        { stepOrder: 6, delayMinutes: 43200, objective: 'final_attempt' },
      ],
    },
  },

  // ==========================================
  // no_reply_after_conversion
  // ==========================================
  {
    name: 'Conservative — After Conversion Step',
    triggerState: 'no_reply_after_conversion',
    preset: 'conservative',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 60, objective: 'booking_reminder' },
        { stepOrder: 1, delayMinutes: 1440, objective: 'urgency_nudge' },
      ],
    },
  },
  {
    name: 'Standard — After Conversion Step',
    triggerState: 'no_reply_after_conversion',
    preset: 'standard',
    platforms: ['yelp', 'thumbtack'],
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 15, objective: 'booking_reminder' },
        { stepOrder: 1, delayMinutes: 60, objective: 'urgency_nudge' },
        { stepOrder: 2, delayMinutes: 1440, objective: 'availability_check' },
        { stepOrder: 3, delayMinutes: 4320, objective: 'last_chance' },
      ],
    },
  },
  {
    name: 'Persistent — After Conversion Step',
    triggerState: 'no_reply_after_conversion',
    preset: 'persistent',
    platforms: ['yelp', 'thumbtack'],
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 15, objective: 'booking_reminder' },
        { stepOrder: 1, delayMinutes: 60, objective: 'urgency_nudge' },
        { stepOrder: 2, delayMinutes: 1440, objective: 'availability_check' },
        { stepOrder: 3, delayMinutes: 4320, objective: 'last_chance' },
        { stepOrder: 4, delayMinutes: 10080, objective: 'monthly_check' },
        { stepOrder: 5, delayMinutes: 20160, objective: 'final_attempt' },
      ],
    },
  },

  // ==========================================
  // customer_deferred — fires when the customer says "I'll get back to
  // you" / "let me think". Single-step, default 3 days. Default generation
  // mode is AI (the literal fallback message lives in the editable
  // Templates list as "Customer Deferral").
  // ==========================================
  {
    name: 'Customer Deferred Check-In',
    triggerState: 'customer_deferred',
    preset: 'standard',
    platforms: ['yelp', 'thumbtack'],
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        {
          stepOrder: 0,
          delayMinutes: 4320, // 3 days
          objective: 'follow_up',
          // messageTemplate intentionally omitted — engine takes the AI
          // path when it is null/empty. Users who flip the section to
          // Template mode get a starter from the "Customer Deferral"
          // MessageTemplate seed (src/templates/templates.service.ts).
        },
      ],
    },
  },

  // ==========================================
  // customer_hired_competitor — fires when the customer says they hired
  // someone else. Single-step, default 21 days. Default generation mode is
  // AI (the literal fallback message lives in the editable Templates list
  // as "Re-engage"). Supersedes the old Lead.reengageAt = now+75d behavior.
  // ==========================================
  {
    name: 'Customer Hired Competitor Re-Engage',
    triggerState: 'customer_hired_competitor',
    preset: 'standard',
    platforms: ['yelp', 'thumbtack'],
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        {
          stepOrder: 0,
          delayMinutes: 30240, // 21 days
          objective: 'follow_up',
          // messageTemplate intentionally omitted — see customer_deferred
          // note above. Fallback literal lives in the "Re-engage"
          // MessageTemplate seed.
        },
      ],
    },
  },
] as const;

/**
 * Customer-reply trigger states — auto-fired by phrase detection in
 * automation.service.ts (deferral / hired-competitor). Use auto_send
 * because we want to fire without admin review.
 */
const CUSTOMER_REPLY_TRIGGER_STATES = ['customer_deferred', 'customer_hired_competitor'] as const;

function modeForTriggerState(triggerState: string): 'suggest' | 'auto_send' {
  return (CUSTOMER_REPLY_TRIGGER_STATES as readonly string[]).includes(triggerState) ? 'auto_send' : 'suggest';
}

function generationModeForTriggerState(_triggerState: string): 'ai' | 'template' {
  // All preset trigger states default to AI generation. Users can flip
  // an individual sequence to template mode from the UI; the propagate
  // path in follow-up-engine.controller writes generationMode='template'
  // + a literal messageTemplate (sourced from the user's edit or the
  // matching MessageTemplate seed) when they do.
  return 'ai';
}

/**
 * Seed preset templates for a user.
 * Called during onboarding or manually from admin.
 * Only seeds if no templates exist for this user+platform.
 */
export async function seedPresetsForUser(
  prisma: any,
  userId: string,
  platform: string = 'yelp',
  activeHoursStart: string = '09:00',
  activeHoursEnd: string = '21:00',
  activeHoursTimezone: string = 'America/New_York',
  savedAccountId?: string,
): Promise<number> {
  // Check if already seeded for this account (or user if no account)
  const existing = await prisma.followUpSequenceTemplate.count({
    where: savedAccountId
      ? { savedAccountId, platform }
      : { userId, platform, savedAccountId: null },
  });
  if (existing > 0) return 0;

  let seeded = 0;
  for (const preset of FOLLOW_UP_PRESETS) {
    if (!(preset.platforms as readonly string[]).includes(platform)) continue;

    await prisma.followUpSequenceTemplate.create({
      data: {
        userId,
        savedAccountId: savedAccountId || null,
        platform,
        name: preset.name,
        triggerState: preset.triggerState,
        mode: modeForTriggerState(preset.triggerState),
        generationMode: generationModeForTriggerState(preset.triggerState),
        preset: preset.preset,
        isDefault: (preset as any).isDefault || false,
        activeHoursStart,
        activeHoursEnd,
        activeHoursTimezone,
        stepsJson: preset.stepsJson,
        schemaVersion: 1,
        enabled: true,
      },
    });
    seeded++;
  }

  return seeded;
}

/**
 * Idempotently seed JUST the customer-reply trigger templates (deferred,
 * hired-competitor). Safe to call on accounts that already have the older
 * 12 presets — only creates rows for the trigger states that are missing.
 *
 * Used as a lazy backfill: the first time a customer says "I'll get back
 * to you" on an account that pre-dates this feature, this seeds the
 * template so the enrollment can proceed.
 */
export async function ensureCustomerReplyPresets(
  prisma: any,
  userId: string,
  platform: string,
  savedAccountId: string | null,
  activeHoursStart: string = '09:00',
  activeHoursEnd: string = '21:00',
  activeHoursTimezone: string = 'America/New_York',
): Promise<number> {
  let created = 0;
  for (const triggerState of CUSTOMER_REPLY_TRIGGER_STATES) {
    const exists = await prisma.followUpSequenceTemplate.findFirst({
      where: savedAccountId
        ? { savedAccountId, platform, triggerState }
        : { userId, platform, savedAccountId: null, triggerState },
      select: { id: true },
    });
    if (exists) continue;

    const preset = FOLLOW_UP_PRESETS.find(
      p => p.triggerState === triggerState && (p.platforms as readonly string[]).includes(platform),
    );
    if (!preset) continue;

    await prisma.followUpSequenceTemplate.create({
      data: {
        userId,
        savedAccountId: savedAccountId,
        platform,
        name: preset.name,
        triggerState: preset.triggerState,
        mode: modeForTriggerState(triggerState),
        generationMode: generationModeForTriggerState(triggerState),
        preset: preset.preset,
        isDefault: true,
        activeHoursStart,
        activeHoursEnd,
        activeHoursTimezone,
        stepsJson: preset.stepsJson,
        schemaVersion: 1,
        enabled: true,
      },
    });
    created++;
  }
  return created;
}
