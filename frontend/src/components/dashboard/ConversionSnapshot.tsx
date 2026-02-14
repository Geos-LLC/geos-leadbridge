import { TrendingUp, Users } from 'lucide-react';

interface ConversionSnapshotProps {
  leadsLast7Days: number;
  customerEngagementRate7d: number;
  totalAutoRepliesSent: number;
  totalSmsSent: number;
}

export default function ConversionSnapshot({
  leadsLast7Days,
  customerEngagementRate7d,
  totalAutoRepliesSent,
  totalSmsSent,
}: ConversionSnapshotProps) {
  return (
    <section className="dashboard-section">
      <h2>7-Day Snapshot</h2>
      <div className="conversion-snapshot">
        <div className="snapshot-card">
          <div className="snapshot-icon blue">
            <Users size={22} />
          </div>
          <div className="snapshot-info">
            <span className="snapshot-value">{leadsLast7Days}</span>
            <span className="snapshot-label">Leads (Last 7 Days)</span>
          </div>
        </div>

        <div className="snapshot-card">
          <div className="snapshot-icon green">
            <TrendingUp size={22} />
          </div>
          <div className="snapshot-info">
            <span className="snapshot-value">
              {customerEngagementRate7d > 0
                ? `${Math.round(customerEngagementRate7d)}%`
                : '--'}
            </span>
            <span className="snapshot-label">Customer Engagement</span>
          </div>
        </div>

        <div className="snapshot-card">
          <div className="snapshot-icon purple">
            <TrendingUp size={22} />
          </div>
          <div className="snapshot-info">
            <span className="snapshot-value">{totalAutoRepliesSent}</span>
            <span className="snapshot-label">Auto Replies (Lifetime)</span>
          </div>
        </div>

        <div className="snapshot-card">
          <div className="snapshot-icon orange">
            <TrendingUp size={22} />
          </div>
          <div className="snapshot-info">
            <span className="snapshot-value">{totalSmsSent}</span>
            <span className="snapshot-label">SMS Sent (Lifetime)</span>
          </div>
        </div>
      </div>
    </section>
  );
}
