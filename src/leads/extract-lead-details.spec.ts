import { extractLeadDetails } from './extract-lead-details';

describe('extractLeadDetails', () => {
  it('returns {} for null/undefined/empty input', () => {
    expect(extractLeadDetails(null)).toEqual({});
    expect(extractLeadDetails(undefined)).toEqual({});
    expect(extractLeadDetails('')).toEqual({});
  });

  it('returns {} for invalid JSON', () => {
    expect(extractLeadDetails('{not json')).toEqual({});
  });

  it('returns {} for non-object payloads (e.g. JSON array, string, number)', () => {
    expect(extractLeadDetails('[1,2,3]')).toEqual({});
    expect(extractLeadDetails('"hello"')).toEqual({});
    expect(extractLeadDetails('42')).toEqual({});
  });

  describe('Thumbtack shape', () => {
    it('parses request.details[]', () => {
      const raw = JSON.stringify({
        request: {
          details: [
            { question: 'Bedrooms', answer: '3' },
            { question: 'Bathrooms', answer: '2' },
          ],
          description: 'Deep clean please',
        },
      });
      expect(extractLeadDetails(raw)).toEqual({
        Bedrooms: '3',
        Bathrooms: '2',
        Description: 'Deep clean please',
      });
    });

    it('accepts legacy top-level details[]', () => {
      const raw = JSON.stringify({
        details: [{ question: 'Bedrooms', answer: '3' }],
        description: 'desc',
      });
      expect(extractLeadDetails(raw)).toEqual({
        Bedrooms: '3',
        Description: 'desc',
      });
    });
  });

  describe('Yelp shape (regression for Spotless Homes Tampa 2026-06-15)', () => {
    it('parses project.survey_answers[] — the bug that produced the generic AI reply', () => {
      const raw = JSON.stringify({
        user: { display_name: 'Jose' },
        project: {
          survey_answers: [
            { question_text: 'What kind of work would you like to get done?', answer_text: 'Regular cleaning' },
            { question_text: 'How often do you want your home cleaned?', answer_text: 'Once a month' },
            { question_text: 'How many bedrooms are in your home?', answer_text: '2 bedrooms' },
            { question_text: 'How many bathrooms are in your home?', answer_text: '2 bathrooms' },
            { question_text: 'When do you require this service?', answer_text: "I'm flexible" },
            { question_text: 'In what location do you need the service?', answer_text: '33815' },
          ],
        },
      });
      const out = extractLeadDetails(raw);
      expect(out['What kind of work would you like to get done?']).toBe('Regular cleaning');
      expect(out['How many bedrooms are in your home?']).toBe('2 bedrooms');
      expect(out['How many bathrooms are in your home?']).toBe('2 bathrooms');
      expect(out['In what location do you need the service?']).toBe('33815');
    });

    it('joins answer_text arrays (multi-select)', () => {
      const raw = JSON.stringify({
        project: {
          survey_answers: [
            { question_text: 'Add-ons', answer_text: ['Oven', 'Fridge', 'Windows'] },
          ],
        },
      });
      expect(extractLeadDetails(raw)['Add-ons']).toBe('Oven, Fridge, Windows');
    });

    it('extracts availability and additional_info', () => {
      const raw = JSON.stringify({
        project: {
          survey_answers: [],
          availability: { status: 'Within a week' },
          additional_info: 'Two cats, gate code 1234',
        },
      });
      expect(extractLeadDetails(raw)).toEqual({
        Availability: 'Within a week',
        'Additional details': 'Two cats, gate code 1234',
      });
    });
  });

  describe('flat top-level fields', () => {
    it('pulls bedrooms/bathrooms/sqft/serviceType/frequency when survey is absent', () => {
      const raw = JSON.stringify({
        bedrooms: 3,
        bathrooms: 2,
        squareFeet: 1800,
        serviceType: 'Deep cleaning',
        frequency: 'one-time',
      });
      expect(extractLeadDetails(raw)).toEqual({
        Bedrooms: '3',
        Bathrooms: '2',
        'Square footage': '1800',
        'Cleaning type': 'Deep cleaning',
        Frequency: 'one-time',
      });
    });

    it('accepts snake_case alternatives (square_feet, service_type)', () => {
      const raw = JSON.stringify({ square_feet: 2200, service_type: 'Move-out' });
      expect(extractLeadDetails(raw)).toEqual({
        'Square footage': '2200',
        'Cleaning type': 'Move-out',
      });
    });

    it('does NOT overwrite survey-derived labels with flat fields', () => {
      const raw = JSON.stringify({
        bedrooms: 99,
        project: {
          survey_answers: [
            { question_text: 'Bedrooms', answer_text: '3' },
          ],
        },
      });
      expect(extractLeadDetails(raw)['Bedrooms']).toBe('3');
    });
  });

  it('does not throw on missing answer fields', () => {
    const raw = JSON.stringify({
      project: {
        survey_answers: [
          { question_text: 'no answer' },
          { answer_text: 'no question' },
          { question_text: 'has answer', answer_text: 'yes' },
        ],
      },
    });
    expect(extractLeadDetails(raw)).toEqual({ 'has answer': 'yes' });
  });
});
