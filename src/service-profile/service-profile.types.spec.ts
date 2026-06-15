/**
 * Wrapper-shape regression tests for buildPlaybookSettingsForRenderer
 * and extractServiceRules.
 *
 * The wrapper shape ships in PR-A so a preset-created profile can
 * carry serviceRules in aiInstructionsJson without colliding with the
 * legacy "raw V2 sections at top level" shape that
 * playback-renderer.ts already consumes. These tests pin the
 * detection rules so we don't accidentally re-break the legacy path.
 */

import { buildPlaybookSettingsForRenderer, extractServiceRules } from './service-profile.types';

describe('buildPlaybookSettingsForRenderer — wrapper vs legacy shape', () => {
  it('legacy raw-sections shape: passes through unchanged into aiPlaybookV2 key', () => {
    const profileAi = JSON.stringify({
      personality_brand_voice: { customInstructions: 'Be friendly' },
      pricing_guidance: { customInstructions: 'Quote per item' },
    });
    const result = buildPlaybookSettingsForRenderer(profileAi, null);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.aiPlaybookV2.personality_brand_voice.customInstructions).toBe('Be friendly');
    expect(parsed.aiPlaybookV2.pricing_guidance.customInstructions).toBe('Quote per item');
  });

  it('wrapper shape with no aiPlaybookV2: returns legacy blob unchanged (no playbook injection)', () => {
    const profileAi = JSON.stringify({
      version: 1,
      serviceRules: {
        requiredDetails: ['Fabric type'],
        unsupportedServices: ['Leather cleaning'],
        workflowSteps: ['Ask for fabric type'],
      },
    });
    const legacyFollow = JSON.stringify({ priceQuoteMode: 'aggressive' });
    const result = buildPlaybookSettingsForRenderer(profileAi, legacyFollow);
    // Wrapper carries no V2 sections → renderer gets legacy untouched.
    // The serviceRules data is consumed by a different surface (the
    // Services detail UI). Today the playbook renderer ignores it.
    expect(result).toBe(legacyFollow);
  });

  it('wrapper shape with aiPlaybookV2: splices V2 over the legacy blob', () => {
    const profileAi = JSON.stringify({
      version: 1,
      serviceRules: { requiredDetails: ['Fabric type'], unsupportedServices: [], workflowSteps: [] },
      aiPlaybookV2: {
        personality_brand_voice: { customInstructions: 'Be warm' },
      },
    });
    const legacyFollow = JSON.stringify({ priceQuoteMode: 'aggressive' });
    const result = buildPlaybookSettingsForRenderer(profileAi, legacyFollow);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.priceQuoteMode).toBe('aggressive');
    expect(parsed.aiPlaybookV2.personality_brand_voice.customInstructions).toBe('Be warm');
  });

  it('null profile value: returns the legacy blob unchanged', () => {
    const legacyFollow = JSON.stringify({ priceQuoteMode: 'aggressive' });
    expect(buildPlaybookSettingsForRenderer(null, legacyFollow)).toBe(legacyFollow);
  });

  it('unparseable profile value: returns the legacy blob unchanged', () => {
    const legacyFollow = JSON.stringify({ priceQuoteMode: 'aggressive' });
    expect(buildPlaybookSettingsForRenderer('not json', legacyFollow)).toBe(legacyFollow);
  });
});

describe('extractServiceRules — wrapper shape only', () => {
  it('extracts the three string arrays from a wrapper-shape blob', () => {
    const ai = JSON.stringify({
      version: 1,
      serviceRules: {
        requiredDetails: ['Fabric type', 'Address'],
        unsupportedServices: ['Leather cleaning'],
        workflowSteps: ['Ask for fabric type', 'Collect address'],
      },
    });
    expect(extractServiceRules(ai)).toEqual({
      requiredDetails: ['Fabric type', 'Address'],
      unsupportedServices: ['Leather cleaning'],
      workflowSteps: ['Ask for fabric type', 'Collect address'],
    });
  });

  it('returns null for the legacy raw-sections shape', () => {
    const legacyAi = JSON.stringify({
      personality_brand_voice: { customInstructions: 'Be friendly' },
    });
    expect(extractServiceRules(legacyAi)).toBeNull();
  });

  it('filters non-string entries from each array', () => {
    const ai = JSON.stringify({
      version: 1,
      serviceRules: {
        requiredDetails: ['Fabric type', 42, null, 'Address'],
        unsupportedServices: [],
        workflowSteps: ['Greet', { not: 'a string' }],
      },
    });
    expect(extractServiceRules(ai)).toEqual({
      requiredDetails: ['Fabric type', 'Address'],
      unsupportedServices: [],
      workflowSteps: ['Greet'],
    });
  });

  it('returns null for null / unparseable / non-object inputs', () => {
    expect(extractServiceRules(null)).toBeNull();
    expect(extractServiceRules(undefined)).toBeNull();
    expect(extractServiceRules('')).toBeNull();
    expect(extractServiceRules('not json')).toBeNull();
    expect(extractServiceRules('[1,2,3]')).toBeNull();
    expect(extractServiceRules('"a string"')).toBeNull();
  });
});
