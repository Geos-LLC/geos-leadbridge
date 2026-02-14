import { Users, MessageSquare, Phone, Clock } from 'lucide-react';

interface TodaysActivityProps {
  leadsToday: number;
  smsSentToday: number;
  avgResponseTime: number | null;
}

function formatResponseTime(minutes: number | null): string {
  if (minutes === null || minutes === 0) return '--';
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export default function TodaysActivity({
  leadsToday,
  smsSentToday,
  avgResponseTime,
}: TodaysActivityProps) {
  const metrics = [
    {
      label: 'Leads Today',
      value: leadsToday,
      icon: <Users size={24} />,
      color: 'blue',
    },
    {
      label: 'SMS Sent Today',
      value: smsSentToday,
      icon: <MessageSquare size={24} />,
      color: 'green',
    },
    {
      label: 'Calls Connected',
      value: 0,
      subtext: 'Coming Soon',
      icon: <Phone size={24} />,
      color: 'gray',
      comingSoon: true,
    },
    {
      label: 'Avg Response Time',
      value: formatResponseTime(avgResponseTime),
      icon: <Clock size={24} />,
      color: 'purple',
    },
  ];

  return (
    <div className="metrics-summary">
      {metrics.map(metric => (
        <div
          key={metric.label}
          className={`metric-card ${metric.color} ${metric.comingSoon ? 'coming-soon' : ''}`}
        >
          <div className="metric-icon">{metric.icon}</div>
          <div className="metric-info">
            <span className="metric-value">{metric.value}</span>
            <span className="metric-label">{metric.label}</span>
            {metric.subtext && (
              <span className="metric-subtext">{metric.subtext}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
