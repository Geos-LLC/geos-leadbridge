/**
 * Follow-Up State Service
 *
 * Isolated: derives followUpState from ThreadContext fields.
 * Platform-splittable: Yelp and Thumbtack rules can diverge here
 * without spreading conditionals through the engine.
 *
 * ThreadContext is source of truth — this service only READS it.
 */

import { Injectable, Logger } from '@nestjs/common';

/** Thread context fields needed for state derivation */
export interface ThreadStateInput {
  stage: string;
  engagementLevel: string;
  awaitingCustomerReply: boolean;
  priceDiscussed: boolean;
  lastQuestionAsked: string | null;
  businessMessages: number;
  aiMessages: number;
  customerMessages: number;
}

/** Follow-up states ordered by specificity (most specific first) */
export const FOLLOW_UP_STATES = [
  'no_reply_after_conversion',
  'no_reply_after_price',
  'no_reply_after_question',
  'no_reply_after_initial',
] as const;

export type FollowUpState = typeof FOLLOW_UP_STATES[number];

@Injectable()
export class FollowUpStateService {
  private readonly logger = new Logger(FollowUpStateService.name);

  /**
   * Derive the follow-up state from ThreadContext fields.
   * Returns the most specific applicable state, or null if not eligible.
   *
   * Priority: conversion > price > question > initial
   */
  deriveFollowUpState(ctx: ThreadStateInput, _platform?: string): FollowUpState | null {
    // Not eligible for follow-up
    if (!ctx.awaitingCustomerReply) return null;
    if (ctx.stage === 'booked') return null;
    if (ctx.stage === 'lost') return null;
    if (ctx.stage === 'closed') return null;
    if (ctx.engagementLevel === 'cold') return null;

    // No business response yet — nothing to follow up on
    if (ctx.businessMessages < 1 && ctx.aiMessages < 1) return null;

    // Most specific first
    if (ctx.stage === 'negotiation') return 'no_reply_after_conversion';
    if (ctx.priceDiscussed) return 'no_reply_after_price';
    if (ctx.lastQuestionAsked) return 'no_reply_after_question';

    return 'no_reply_after_initial';
  }
}
