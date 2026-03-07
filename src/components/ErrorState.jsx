const ErrorState = ({ title = '加载失败', message = '请稍后重试', onRetry }) => {
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--danger)]/40 rounded-lg p-6">
      <p className="text-lg font-bold text-[var(--danger)]">{title}</p>
      <p className="text-sm text-[var(--text-secondary)] mt-2">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 px-4 py-2 bg-[var(--danger)] text-white text-sm rounded hover:opacity-90 transition-opacity"
        >
          重试
        </button>
      ) : null}
    </div>
  );
};

export default ErrorState;
