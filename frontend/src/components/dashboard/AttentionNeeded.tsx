import { useNavigate } from 'react-router-dom';
import { AlertCircle, MessageSquare, AlertTriangle } from 'lucide-react';
import type { HealthIssue } from '../../services/api';

interface AttentionNeededProps {
  unrepliedLeadCount: number;
  failedSmsCount: number;
  healthIssues: HealthIssue[];
  onScrollToManage: () => void;
}

export default function AttentionNeeded({
  unrepliedLeadCount,
  failedSmsCount,
  healthIssues,
  onScrollToManage,
}: AttentionNeededProps) {
  const navigate = useNavigate();

  const items: {
    count: number;
    label: string;
    description: string;
    severity: 'urgent' | 'warning';
    onClick: () => void;
    icon: React.ReactNode;
  }[] = [];

  if (unrepliedLeadCount > 0) {
    items.push({
      count: unrepliedLeadCount,
      label: `Lead${unrepliedLeadCount > 1 ? 's' : ''} Not Replied`,
      description: 'New leads awaiting your response',
      severity: 'urgent',
      onClick: () => navigate('/messages'),
      icon: <MessageSquare size={20} />,
    });
  }

  if (failedSmsCount > 0) {
    items.push({
      count: failedSmsCount,
      label: `SMS Failed`,
      description: 'Messages that could not be delivered today',
      severity: 'urgent',
      onClick: () => navigate('/notifications'),
      icon: <AlertCircle size={20} />,
    });
  }

  // Config issues from health check
  const configIssues = healthIssues.filter(i => i.severity === 'warning');
  if (configIssues.length > 0) {
    items.push({
      count: configIssues.length,
      label: `Config Issue${configIssues.length > 1 ? 's' : ''}`,
      description: configIssues[0].message,
      severity: 'warning',
      onClick: onScrollToManage,
      icon: <AlertTriangle size={20} />,
    });
  }

  if (items.length === 0) return null;

  return (
    <section className="dashboard-section">
      <h2>Attention Needed</h2>
      <div className="attention-grid">
        {items.map((item, i) => (
          <div
            key={i}
            className={`attention-card ${item.severity}`}
            onClick={item.onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && item.onClick()}
          >
            <div className="attention-icon">{item.icon}</div>
            <div className="attention-info">
              <div className="attention-count">{item.count}</div>
              <div className="attention-label">{item.label}</div>
              <div className="attention-desc">{item.description}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
