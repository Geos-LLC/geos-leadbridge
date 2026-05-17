-- 8-step guided setup wizard progress state on OnboardingProfile.
-- Independent of the legacy step1/step2 segmentation quiz — those columns
-- stay populated for historical analytics but no longer drive UI gating
-- (Modal A retired in this PR; Modal B was already hidden).
--
-- Field semantics:
--   wizard_started_at        — set the first time the user opens /onboarding/setup
--   wizard_completed_at      — set when the wizard reaches the Done step
--   wizard_current_step      — slug of the step the user last viewed; used to resume
--   wizard_skipped_steps     — flat list of step slugs the user explicitly skipped
--   wizard_checklist_status  — JSON map of step slug → 'done' | 'skipped' for the
--                              Overview setup-progress card
--
-- Defaults are intentionally nullable + empty so existing OnboardingProfile
-- rows need no backfill — the wizard treats null as "not yet started".

ALTER TABLE "onboarding_profiles"
  ADD COLUMN "wizardStartedAt"       TIMESTAMP(3),
  ADD COLUMN "wizardCompletedAt"     TIMESTAMP(3),
  ADD COLUMN "wizardCurrentStep"     TEXT,
  ADD COLUMN "wizardSkippedSteps"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "wizardChecklistStatus" JSONB;
