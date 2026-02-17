import { createPortal } from 'react-dom';
import { useNotificationStore, type NotificationType } from '../store/notificationStore';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

const iconMap: Record<NotificationType, React.ReactNode> = {
  error: <AlertCircle size={20} />,
  warning: <AlertTriangle size={20} />,
  success: <CheckCircle size={20} />,
  info: <Info size={20} />,
};

export function ToastNotifications() {
  const { notifications, removeNotification } = useNotificationStore();

  if (notifications.length === 0) return null;

  return createPortal(
    <div className="toast-container">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={`toast toast-${notification.type}`}
          role="alert"
        >
          <div className="toast-icon">{iconMap[notification.type]}</div>
          <div className="toast-content">
            <div className="toast-title">{notification.title}</div>
            <div className="toast-message">{notification.message}</div>
          </div>
          {notification.dismissible && (
            <button
              className="toast-dismiss"
              onClick={() => removeNotification(notification.id)}
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
