export default function StatsCard({ title, value, trend, icon, className = '' }) {
  const StatIcon = icon;
  return (
    <div className={`stat-card ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <p className="text-sm text-[var(--text-secondary)] mb-1">{title}</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{value}</p>
          
          {trend !== undefined && trend !== null && (
            <p className={`text-sm mt-2 ${
              trend > 0 
                ? 'text-[var(--status-done)]' 
                : trend < 0 
                ? 'text-[var(--status-blocked)]' 
                : 'text-[var(--text-secondary)]'
            }`}>
              {trend > 0 ? '↑' : trend < 0 ? '↓' : '→'} {Math.abs(trend)}%
              <span className="text-[var(--text-tertiary)] ml-1">vs 上周</span>
            </p>
          )}
        </div>
        
        <div className="stat-card-icon">
          <StatIcon className="w-6 h-6 text-[var(--accent-primary)]" />
        </div>
      </div>
    </div>
  );
}
