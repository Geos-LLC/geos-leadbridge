/**
 * Lead detail extractor — single source of truth.
 *
 * Parses `lead.rawJson` into the `Record<string, string>` shape consumed by:
 *   - AiService.generateReply (renders the "Job details:" block in the user prompt)
 *   - pricing-engine.computeQuoteAndIntent (resolves bedrooms/bathrooms/sqft → price row)
 *   - addon-extractor (merges Q&A into add-on signal extraction)
 *
 * Replaces four near-identical private `extractLeadDetails` methods that
 * drifted apart — automation.service was Thumbtack-only, the other three
 * had Yelp support. The drift caused the Spotless Homes Tampa Yelp lead
 * (2026-06-15) to receive a generic "How can I assist you today?" reply
 * because the AI Conversation path saw empty leadDetails, which in turn
 * suppressed the Job-details block, the deterministic quote, and the
 * price-intent enforcement guard.
 *
 * Platform shapes supported:
 *   - Thumbtack:  raw.request.details[].{question,answer}  (current)
 *                 raw.details[].{question,answer}          (legacy fallback)
 *                 raw.request.description / raw.description
 *   - Yelp:       raw.project.survey_answers[].{question_text,answer_text}
 *                 raw.project.availability.status        → "Availability"
 *                 raw.project.additional_info            → "Additional details"
 *   - Flat top-level fields some payloads carry (older TT + test fixtures):
 *                 raw.bedrooms, raw.bathrooms,
 *                 raw.squareFeet / raw.square_feet,
 *                 raw.serviceType / raw.service_type,
 *                 raw.frequency
 *
 * Never throws — returns `{}` on any parse failure or null/undefined input.
 */
export function extractLeadDetails(
  rawJson: string | null | undefined,
): Record<string, string> {
  if (!rawJson) return {};
  let raw: any;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};

  const result: Record<string, string> = {};

  // Thumbtack — survey Q&A.
  const ttDetails: any[] = raw.request?.details || raw.details || [];
  for (const item of ttDetails) {
    if (item?.question && item?.answer) {
      result[String(item.question)] = String(item.answer);
    }
  }

  // Yelp — survey Q&A. answer_text is occasionally an array (multi-select).
  const yelpSurvey: any[] = raw.project?.survey_answers || [];
  for (const q of yelpSurvey) {
    if (q?.question_text && q?.answer_text !== undefined && q?.answer_text !== null) {
      const a = Array.isArray(q.answer_text) ? q.answer_text.join(', ') : String(q.answer_text);
      result[String(q.question_text)] = a;
    }
  }

  // Yelp-specific extras.
  if (raw.project?.availability?.status) {
    result['Availability'] = String(raw.project.availability.status);
  }
  if (raw.project?.additional_info) {
    result['Additional details'] = String(raw.project.additional_info);
  }

  // Top-level flat fields. Lower priority than survey Q&A — only set when
  // the survey didn't already carry the same fact under a different label.
  if (raw.bedrooms !== undefined && raw.bedrooms !== null && result['Bedrooms'] === undefined) {
    result['Bedrooms'] = String(raw.bedrooms);
  }
  if (raw.bathrooms !== undefined && raw.bathrooms !== null && result['Bathrooms'] === undefined) {
    result['Bathrooms'] = String(raw.bathrooms);
  }
  const sqft = raw.squareFeet ?? raw.square_feet;
  if (sqft !== undefined && sqft !== null && result['Square footage'] === undefined) {
    result['Square footage'] = String(sqft);
  }
  const svc = raw.serviceType ?? raw.service_type;
  if (svc && result['Cleaning type'] === undefined) {
    result['Cleaning type'] = String(svc);
  }
  if (raw.frequency && result['Frequency'] === undefined) {
    result['Frequency'] = String(raw.frequency);
  }

  // Description — some TT payloads carry a free-form description alongside details.
  const description = raw.request?.description ?? raw.description;
  if (description && result['Description'] === undefined) {
    result['Description'] = String(description);
  }

  return result;
}
