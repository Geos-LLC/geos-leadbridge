import { create } from 'zustand';

export type NotificationType = 'error' | 'warning' | 'success' | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  duration?: number; // auto-dismiss after ms (0 = manual dismiss only)
  dismissible?: boolean;
}

interface NotificationState {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id'>) => string;
  removeNotification: (id: string) => void;
  clearAll: () => void;
}

let notificationId = 0;

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],

  addNotification: (notification) => {
    const id = `notification-${++notificationId}`;
    const newNotification: Notification = {
      id,
      dismissible: true,
      duration: notification.type === 'error' ? 8000 : 5000, // errors stay longer
      ...notification,
    };

    set((state) => ({
      notifications: [...state.notifications, newNotification],
    }));

    // Auto-dismiss if duration is set
    if (newNotification.duration && newNotification.duration > 0) {
      setTimeout(() => {
        get().removeNotification(id);
      }, newNotification.duration);
    }

    return id;
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAll: () => {
    set({ notifications: [] });
  },
}));

// Helper functions for common notification types
export const notify = {
  error: (title: string, message: string, duration?: number) => {
    return useNotificationStore.getState().addNotification({
      type: 'error',
      title,
      message,
      duration,
    });
  },
  warning: (title: string, message: string, duration?: number) => {
    return useNotificationStore.getState().addNotification({
      type: 'warning',
      title,
      message,
      duration,
    });
  },
  success: (title: string, message: string, duration?: number) => {
    return useNotificationStore.getState().addNotification({
      type: 'success',
      title,
      message,
      duration: duration ?? 4000,
    });
  },
  info: (title: string, message: string, duration?: number) => {
    return useNotificationStore.getState().addNotification({
      type: 'info',
      title,
      message,
      duration: duration ?? 5000,
    });
  },
};
