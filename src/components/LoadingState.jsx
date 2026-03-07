const LoadingState = ({ title = '加载中...', description = '正在获取最新数据' }) => {
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6">
      <div className="animate-pulse-slow">
        <p className="text-lg font-bold text-[var(--text-primary)]">{title}</p>
        <p className="text-sm text-[var(--text-secondary)] mt-2">{description}</p>
      </div>
    </div>
  );
};

export default LoadingState;
