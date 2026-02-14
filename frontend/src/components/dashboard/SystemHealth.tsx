import { Zap, MessageSquare, Phone, Bell } from 'lucide-react';

interface SystemHealthProps {
  autoReplyEnabled: boolean;
  customerSmsEnabled: boolean;
  leadAlertsEnabled: boolean;
}

interface HealthCard {
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  comingSoon?: boolean;
}

export default function SystemHealth({
  autoReplyEnabled,
  customerSmsEnabled,
  leadAlertsEnabled,
}: SystemHealthProps) {
  const cards: HealthCard[] = [
    {
      label: 'Auto Reply',
      icon: <Zap size={20} />,
      enabled: autoReplyEnabled,
    },
    {
      label: 'Customer SMS',
      icon: <MessageSquare size={20} />,
      enabled: customerSmsEnabled,
    },
    {
      label: 'Call Connect',
      icon: <Phone size={20} />,
      enabled: false,
      comingSoon: true,
    },
    {
      label: 'Lead Alerts',
      icon: <Bell size={20} />,
      enabled: leadAlertsEnabled,
    },
  ];

  return (
    <div className="health-status-grid">
      {cards.map(card => (
        <div
          key={card.label}
          className={`health-status-card ${card.comingSoon ? 'coming-soon' : card.enabled ? 'on' : 'off'}`}
        >
          <div className="health-card-icon">{card.icon}</div>
          <div className="health-card-info">
            <span className="health-card-label">{card.label}</span>
            {card.comingSoon ? (
              <span className="status-indicator coming-soon">Coming Soon</span>
            ) : (
              <span className={`status-indicator ${card.enabled ? 'on' : 'off'}`}>
                {card.enabled ? 'ON' : 'OFF'}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
