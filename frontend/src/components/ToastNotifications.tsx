/**
 * Global toast container — portaled into <body>, fixed top-right.
 *
 * History: this component used to depend on .toast-* classes that live
 * in App.css. App.css was orphaned during the Tailwind migration (no
 * file imports it), so the classes never reached the bundle and toasts
 * rendered as unstyled text at the natural body position. Inline
 * styles using the --lb-* design tokens from index.css are
 * self-contained — toasts work regardless of what global stylesheets
 * happen to be loaded.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNotificationStore, type NotificationType } from '../store/notificationStore';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

const iconMap: Record<NotificationType, React.ReactNode> = {
  error: <AlertCircle size={20} />,
  warning: <AlertTriangle size={20} />,
  success: <CheckCircle size={20} />,
  info: <Info size={20} />,
};

const borderByType: Record<NotificationType, string> = {
  error: '#dc2626',
  warning: '#f59e0b',
  success: '#16a34a',
  info: '#2563eb',
};

const iconColorByType: Record<NotificationType, string> = {
  error: '#dc2626',
  warning: '#f59e0b',
  success: '#16a34a',
  info: '#2563eb',
};

function useIsNarrow(breakpoint = 640): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.innerWidth <= breakpoint,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return narrow;
}

export function ToastNotifications() {
  const { notifications, removeNotification } = useNotificationStore();
  const isNarrow = useIsNarrow();

  if (notifications.length === 0) return null;

  const containerStyle: React.CSSProperties = isNarrow
    ? {
        position: 'fixed',
        bottom: 16,
        left: 16,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }
    : {
        position: 'fixed',
        top: 72,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 420,
        width: 'calc(100vw - 32px)',
        pointerEvents: 'none',
      };

  return createPortal(
    <div style={containerStyle} role="region" aria-label="Notifications">
      {notifications.map((notification) => {
        const border = borderByType[notification.type];
        const iconColor = iconColorByType[notification.type];
        return (
          <div
            key={notification.id}
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '14px 16px',
              borderRadius: 10,
              boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.25)',
              background: 'white',
              borderLeft: `4px solid ${border}`,
              pointerEvents: 'auto',
              animation: 'lb-toast-slide-in 0.22s ease-out',
            }}
          >
            <div style={{ flexShrink: 0, color: iconColor, display: 'flex', alignItems: 'center' }}>
              {iconMap[notification.type]}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2, color: 'var(--lb-ink-1, #0a1530)' }}>
                {notification.title}
              </div>
              <div style={{ fontSize: 13, color: 'var(--lb-ink-4, #3d4a6d)', lineHeight: 1.4, wordWrap: 'break-word' }}>
                {notification.message}
              </div>
            </div>
            {notification.dismissible && (
              <button
                type="button"
                onClick={() => removeNotification(notification.id)}
                aria-label="Dismiss"
                style={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--lb-ink-6, #8b94ab)',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>
        );
      })}
      <style>{`
        @keyframes lb-toast-slide-in {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </div>,
    document.body,
  );
}
