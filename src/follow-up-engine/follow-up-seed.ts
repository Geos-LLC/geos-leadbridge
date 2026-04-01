/**
 * Follow-Up Seed Data
 *
 * 12 preset templates: 4 trigger states × 3 presets (conservative, standard, persistent).
 * Yelp only (v1). Platform field required on every template.
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
    platform: 'yelp',
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
    platform: 'yelp',
    isDefault: true,
    stepsJson: {
      schemaVersion: 1,
      steps: [
        { stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' },
        { stepOrder: 1, delayMinutes: 10, objective: 'value_add' },
        { stepOrder: 2, delayMinutes: 60, objective: 'soft_nudge' },
        { stepOrder: 3, delayMinutes: 1440, objective: 're_engagement' },
        { stepOrder: 4, delayMinutes: 4320, objective: 'last_chance' },
      ],
    },
  },
  {
    name: 'Persistent — After Initial Reply',
    triggerState: 'no_reply_after_initial',
    preset: 'persistent',
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
    platform: 'yelp',
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
] as const;

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
    if (preset.platform !== platform) continue;

    await prisma.followUpSequenceTemplate.create({
      data: {
        userId,
        savedAccountId: savedAccountId || null,
        platform: preset.platform,
        name: preset.name,
        triggerState: preset.triggerState,
        mode: 'suggest',
        generationMode: 'ai',
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
