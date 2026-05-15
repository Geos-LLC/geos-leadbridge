import { useNavigate } from 'react-router-dom';
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
  serviceId?: string;
}

export default function SystemHealth({
  autoReplyEnabled,
  customerSmsEnabled,
  leadAlertsEnabled,
}: SystemHealthProps) {
  const navigate = useNavigate();

  const cards: HealthCard[] = [
    {
      label: 'Auto Reply',
      icon: <Zap size={20} />,
      enabled: autoReplyEnabled,
      serviceId: 'auto-reply',
    },
    {
      label: 'Customer SMS',
      icon: <MessageSquare size={20} />,
      enabled: customerSmsEnabled,
      serviceId: 'customer-sms',
    },
    {
      label: 'Call Connect',
      icon: <Phone size={20} />,
      enabled: false,
      serviceId: 'call-connect',
    },
    {
      label: 'Lead Alerts',
      icon: <Bell size={20} />,
      enabled: leadAlertsEnabled,
      serviceId: 'lead-alerts',
    },
  ];

  return (
    <div className="health-status-grid">
      {cards.map(card => (
        <div
          key={card.label}
          className={`health-status-card clickable ${card.comingSoon ? 'coming-soon' : card.enabled ? 'on' : 'off'}`}
          onClick={() => navigate('/automation')}
          style={{ cursor: 'pointer' }}
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
