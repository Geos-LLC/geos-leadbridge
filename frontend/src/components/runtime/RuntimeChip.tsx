/**
 * Generic chip used by the runtime-state panel. Color is determined by the
 * `tone` prop; the label string is whatever the backend `displayLabels` map
 * returned (the vocabulary lives on the server — the UI doesn't translate).
 *
 * `tone` values mirror the StatusPill conventions so this fits visually
 * alongside existing pills until Phase 2 redesigns the lead-detail header.
 */

import type { CSSProperties, ReactNode } from 'react';

export type RuntimeChipTone =
  | 'neutral'
  | 'success'
  | 'warn'
  | 'danger'
  | 'accent'
  | 'muted';

const TONE_STYLE: Record<RuntimeChipTone, { fg: string; bg: string; dot: string }> = {
  neutral: { fg: 'var(--lb-ink-7)', bg: 'var(--lb-ink-10)', dot: 'var(--lb-ink-6)' },
  success: { fg: '#15803d', bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  warn:    { fg: '#92400e', bg: 'var(--lb-warn-tint)',    dot: 'var(--lb-warn)' },
  danger:  { fg: '#991b1b', bg: 'var(--lb-danger-tint)',  dot: 'var(--lb-danger)' },
  accent:  { fg: '#1e40af', bg: 'var(--lb-accent-tint)',  dot: 'var(--lb-accent)' },
  muted:   { fg: 'var(--lb-ink-5)', bg: 'var(--lb-ink-10)', dot: 'var(--lb-ink-6)' },
};

interface RuntimeChipProps {
  label: ReactNode;
  tone?: RuntimeChipTone;
  title?: string;
  /** Optional subtitle text shown beside the label in a smaller, dimmer style. */
  hint?: string;
  style?: CSSProperties;
}

export function RuntimeChip({ label, tone = 'neutral', title, hint, style }: RuntimeChipProps) {
  const s = TONE_STYLE[tone] ?? TONE_STYLE.neutral;
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px 3px 8px',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.01,
        whiteSpace: 'nowrap',
        lineHeight: 1.4,
        ...style,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: s.dot, flexShrink: 0 }} />
      <span>{label}</span>
      {hint && (
        <span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 2 }}>· {hint}</span>
      )}
    </span>
  );
}

/**
 * Pure mapping function: backend label/value → tone color. Kept in this file
 * because it co-evolves with RuntimeChip itself. Centralized here so all
 * runtime-state surfaces (per-lead panel, dashboard, future redesigns) agree.
 *
 * Returns 'muted' for empty/unknown — preserves the legacy "em-dash" visual
 * the backend display helper already uses.
 */
export function toneForRuntime(kind: 'ai' | 'conv' | 'intent' | 'sf' | 'followup' | 'handoff', raw: string | null | undefined): RuntimeChipTone {
  if (!raw || raw === '—') return 'muted';
  if (kind === 'ai') {
    if (raw.includes('active')) return 'success';
    if (raw.includes('disabled')) return 'muted';
    if (raw.includes('paused')) return 'warn';
    if (raw.includes('stopped')) return 'danger';
    if (raw.includes('unavailable')) return 'muted';
    return 'neutral';
  }
  if (kind === 'conv') {
    if (raw.includes('Booked')) return 'success';
    if (raw.includes('Opted out') || raw.includes('Hired elsewhere')) return 'danger';
    if (raw.includes('Closed')) return 'muted';
    if (raw.includes('AI engaging') || raw.includes('Awaiting customer')) return 'accent';
    if (raw.includes('Customer replied')) return 'success';
    if (raw.includes('Human handling')) return 'warn';
    if (raw.includes('Deferred') || raw.includes('Long silent')) return 'warn';
    return 'neutral';
  }
  if (kind === 'intent') {
    if (raw.includes('Ready to book') || raw.includes('Engaged')) return 'success';
    if (raw.includes('Wants live') || raw.includes('Provided phone') || raw.includes('Provided sqft') || raw.includes('Qualification done')) return 'accent';
    if (raw.includes('Opted out') || raw.includes('Hired elsewhere')) return 'danger';
    if (raw.includes('Deferring') || raw.includes('Long-term defer')) return 'warn';
    return 'neutral';
  }
  if (kind === 'sf') {
    if (raw.includes('completed') || raw.includes('scheduled') || raw.includes('confirmed')) return 'success';
    if (raw.includes('in progress')) return 'accent';
    if (raw.includes('cancelled') || raw.includes('no-show')) return 'danger';
    if (raw.includes('archived') || raw.includes('lost')) return 'muted';
    if (raw.includes('pending') || raw.includes('rescheduled')) return 'warn';
    return 'neutral';
  }
  if (kind === 'followup') {
    if (raw.includes('No follow-up')) return 'muted';
    if (raw.includes('stopped')) return 'danger';
    if (raw.includes('completed')) return 'success';
    if (raw.includes('paused')) return 'warn';
    if (raw.startsWith('Follow-up in') || raw.includes('due now')) return 'accent';
    return 'neutral';
  }
  if (kind === 'handoff') {
    if (raw === 'No handoff') return 'muted';
    if (raw === 'Handoff requested') return 'warn';
    if (raw === 'Handoff resolved') return 'success';
    return 'neutral';
  }
  return 'neutral';
}
