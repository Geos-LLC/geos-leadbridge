type Platform = 'thumbtack' | 'yelp' | 'angi' | 'google' | string;

const META: Record<string, { label: string; color: string; short: string }> = {
  thumbtack: { label: 'Thumbtack', color: 'var(--lb-thumbtack)', short: 'TT' },
  yelp:      { label: 'Yelp',      color: 'var(--lb-yelp)',      short: 'Y' },
  angi:      { label: 'Angi',      color: 'var(--lb-angi)',      short: 'A' },
  google:    { label: 'Google',    color: 'var(--lb-google)',    short: 'G' },
};

interface PlatformBadgeProps {
  platform: Platform;
  size?: 'sm' | 'md';
}

export function PlatformBadge({ platform, size = 'sm' }: PlatformBadgeProps) {
  const meta = META[platform] || { label: platform, color: 'var(--lb-ink-5)', short: '?' };
  const s = size === 'sm' ? 18 : 22;
  return (
    <span
      title={meta.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: s,
        height: s,
        borderRadius: 4,
        background: meta.color,
        color: 'white',
        fontFamily: 'var(--lb-font-mono)',
        fontWeight: 600,
        fontSize: size === 'sm' ? 9 : 10,
        letterSpacing: 0.02,
        flexShrink: 0,
      }}
    >
      {meta.short}
    </span>
  );
}
