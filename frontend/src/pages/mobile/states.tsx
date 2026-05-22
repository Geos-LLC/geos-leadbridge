// Loading / empty / error states for mobile screens. Kept minimal — the
// design handoff didn't ship explicit copy for these, so we render
// neutral placeholders matched to the existing tokens.

import type { ReactNode } from 'react';
import { Icon } from './components';
import type { IconName } from './components';

export function MLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div style={{
      padding: '40px 24px', textAlign: 'center',
      color: 'var(--ink-5)', fontSize: 13, fontFamily: 'var(--font-mono)',
    }}>{label}</div>
  );
}

export function MErrorState({ message }: { message: string }) {
  return (
    <div style={{ padding: '0 14px', marginTop: 18 }}>
      <div style={{
        padding: 14, borderRadius: 14,
        background: 'var(--danger-tint)', border: '1px solid #fecaca',
        color: '#7f1d1d', fontSize: 13, lineHeight: 1.5,
      }}>
        <strong>Couldn't load this view.</strong>
        <div style={{ marginTop: 4, opacity: 0.85 }}>{message}</div>
      </div>
    </div>
  );
}

export function MEmpty({
  icon = 'inbox', title, body, action,
}: { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{
      margin: '24px 14px 0', padding: '32px 20px', textAlign: 'center',
      border: '1px dashed var(--line)', borderRadius: 14,
      background: 'var(--surface)',
    }}>
      <div style={{
        display: 'inline-flex', width: 44, height: 44, borderRadius: 999,
        background: 'var(--ink-10)', color: 'var(--ink-5)',
        alignItems: 'center', justifyContent: 'center', marginBottom: 10,
      }}>
        <Icon name={icon} size={20} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>{title}</div>
      {body && <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--ink-5)', lineHeight: 1.5 }}>{body}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
