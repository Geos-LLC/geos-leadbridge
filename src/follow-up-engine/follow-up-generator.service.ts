/**
 * Follow-Up Generator Service
 *
 * Generates follow-up message content from objective + ThreadContext.
 * Supports AI mode (OpenAI) and template mode (static text with variables).
 * Phase 1: stub only. Phase 3 will add full generation.
 */

import { Injectable, Logger } from '@nestjs/common';

/** Step definition from stepsJson */
export interface SequenceStep {
  stepOrder: number;
  delayMinutes: number;
  objective: string;
  messageTemplate?: string | null;
}

/** Generation result */
export interface GeneratedFollowUp {
  message: string;
  objective: string;
  strategyUsed: string | null;
}

@Injectable()
export class FollowUpGeneratorService {
  private readonly logger = new Logger(FollowUpGeneratorService.name);

  /**
   * Generate a follow-up message for a step.
   * Phase 1: returns placeholder. Phase 3: full AI/template generation.
   */
  async generateMessage(
    _step: SequenceStep,
    _conversationId: string,
    _generationMode: 'ai' | 'template',
    _promptTemplateId?: string | null,
  ): Promise<GeneratedFollowUp> {
    // Phase 1 stub — Phase 3 will implement full generation
    this.logger.log(`[FollowUpGenerator] Stub: would generate message for objective=${_step.objective}`);
    return {
      message: `[Follow-up placeholder: ${_step.objective}]`,
      objective: _step.objective,
      strategyUsed: null,
    };
  }
}
