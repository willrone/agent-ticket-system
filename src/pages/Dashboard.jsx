import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { fetchDashboardMetrics } from '../api/dashboard';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

function normalizeMetrics(payload) {
  const data = payload?.data || payload || {};

  return {
    stats: data.stats || {
      total: 0,
      open: 0,
      inProgress: 0,
      resolved: 0,
    },
    weeklyTickets: data.weeklyTickets || [],
    statusDistribution: data.statusDistribution || [],
  };
}

const Dashboard = () => {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await fetchDashboardMetrics();
      setMetrics(normalizeMetrics(payload));
    } catch (err) {
      setError(err?.message || 'Dashboard 数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const stats = useMemo(() => {
    if (!metrics) return [];
    return [
      { label: 'Total Tickets', value: String(metrics.stats.total), icon: TrendingUp, color: 'text-[var(--accent-primary)]' },
      { label: 'Open', value: String(metrics.stats.open), icon: AlertCircle, color: 'text-[var(--danger)]' },
      { label: 'In Progress', value: String(metrics.stats.inProgress), icon: Clock, color: 'text-[var(--warning)]' },
      { label: 'Resolved', value: String(metrics.stats.resolved), icon: CheckCircle, color: 'text-[var(--success)]' },
    ];
  }, [metrics]);

  if (loading) {
    return <LoadingState title="Dashboard 加载中" description="正在拉取指标和趋势数据" />;
  }

  if (error) {
    return <ErrorState title="Dashboard 加载失败" message={error} onRetry={loadMetrics} />;
  }

  return (
    <div className="space-y-6 animate-slide-in">
      <h1 className="text-3xl font-bold text-[var(--text-primary)]">Dashboard</h1>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-[var(--bg-secondary)] overflow-hidden border border-[var(--border-color)] rounded-lg p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0 rounded-md p-3 bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
                  <Icon className={`h-6 w-6 ${stat.color}`} />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dt className="text-sm font-medium text-[var(--text-secondary)] truncate">{stat.label}</dt>
                  <dd className="text-3xl font-semibold text-[var(--text-primary)]">{stat.value}</dd>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Weekly Tickets</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={metrics.weeklyTickets}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
              <XAxis dataKey="day" stroke="var(--text-secondary)" />
              <YAxis stroke="var(--text-secondary)" />
              <Tooltip />
              <Legend />
              <Bar dataKey="tickets" fill="#00d9ff" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Status Distribution</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={metrics.statusDistribution}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                outerRadius={100}
                dataKey="value"
              >
                {metrics.statusDistribution.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color || '#00d9ff'} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
