import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { fetchDashboardMetrics } from '../api/dashboard';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import StatsCard from '../components/StatsCard';

function normalizeMetrics(payload) {
  const data = payload?.data || payload || {};
  const stats = data.stats || {};

  return {
    stats: {
      total: Number(stats.total || 0),
      inProgress: Number(stats.inProgress || 0),
      waitingReview: Number(stats.waitingReview || 0),
      closed: Number(stats.closed || 0),
    },
    weeklyTickets: Array.isArray(data.weeklyTickets) ? data.weeklyTickets : [],
    statusDistribution: Array.isArray(data.statusDistribution) ? data.statusDistribution : [],
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
      { title: '总工单', value: String(metrics.stats.total), icon: TrendingUp },
      { title: '进行中', value: String(metrics.stats.inProgress), icon: Clock },
      { title: '待验收 / 审核中', value: String(metrics.stats.waitingReview), icon: AlertCircle },
      { title: '已结束', value: String(metrics.stats.closed), icon: CheckCircle },
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
        {stats.map((stat) => (
          <StatsCard
            key={stat.title}
            title={stat.title}
            value={stat.value}
            icon={stat.icon}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">最近 7 天新增工单</h2>
          {metrics.weeklyTickets.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={metrics.weeklyTickets}>
                <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                <XAxis dataKey="day" stroke="#8b949e" />
                <YAxis allowDecimals={false} stroke="#8b949e" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#151a23',
                    border: '1px solid #30363d',
                    color: '#e6edf3',
                  }}
                />
                <Legend wrapperStyle={{ color: '#e6edf3' }} />
                <Bar name="新增工单" dataKey="tickets" fill="#00d9ff" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-[var(--text-secondary)]">
              暂无数据
            </div>
          )}
        </div>

        <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">真实状态分布</h2>
          {metrics.statusDistribution.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={metrics.statusDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name} ${value}`}
                  outerRadius={100}
                  dataKey="value"
                >
                  {metrics.statusDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color || '#00d9ff'} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, _name, item) => [`${value}`, item?.payload?.name || '状态']}
                  contentStyle={{
                    backgroundColor: '#151a23',
                    border: '1px solid #30363d',
                    color: '#e6edf3',
                  }}
                />
                <Legend wrapperStyle={{ color: '#e6edf3' }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-[var(--text-secondary)]">
              暂无数据
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
