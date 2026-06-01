import { BrowserRouter as Router, Routes, Route, useLocation, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';
import KanbanBoard from './pages/KanbanBoard';
import BotStatus from './pages/BotStatus';
import Inbox from './pages/Inbox';
import { LayoutDashboard, Ticket, Terminal, Activity, Inbox as InboxIcon, Menu, X } from 'lucide-react';
import { useState } from 'react';

function Sidebar({ isOpen, setIsOpen }) {
  const location = useLocation();
  
  const isActive = (path) => {
    return location.pathname === path;
  };

  const navItems = [
    { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { path: '/tickets', icon: Ticket, label: 'Tickets' },
    { path: '/inbox', icon: InboxIcon, label: 'Inbox' },
    { path: '/bot-status', icon: Activity, label: 'Bot Status' },
    { path: '/kanban', icon: Terminal, label: 'Kanban' },
  ];

  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
      
      {/* Sidebar */}
      <aside className={`
        fixed top-0 left-0 h-full bg-[var(--bg-secondary)] border-r border-[var(--border-color)] z-50
        transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        w-64
      `}>
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-[var(--border-color)]">
          <div className="flex items-center space-x-3">
            <Terminal className="w-6 h-6 text-[var(--accent-primary)]" />
            <span className="text-lg font-bold">
              <span className="text-[var(--accent-primary)]">AGENT</span>
              <span className="text-[var(--text-primary)]">_SYS</span>
            </span>
          </div>
          <button 
            onClick={() => setIsOpen(false)}
            className="lg:hidden text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="p-4 space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setIsOpen(false)}
                className={`
                  flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200
                  ${isActive(item.path)
                    ? 'bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                  }
                `}
              >
                <Icon className="w-5 h-5" />
                <span className="text-sm">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* System Status */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-[var(--border-color)]">
          <div className="flex items-center space-x-2 text-xs">
            <div className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse-slow"></div>
            <span className="text-[var(--text-secondary)] font-mono">SYSTEM_ONLINE</span>
          </div>
        </div>
      </aside>
    </>
  );
}

function TopBar({ onMenuClick }) {
  return (
    <header className="h-16 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex items-center justify-between px-6">
      <button
        onClick={onMenuClick}
        className="lg:hidden text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <Menu className="w-6 h-6" />
      </button>
      
      <div className="flex-1" />
      
      <div className="flex items-center space-x-2">
        <div className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse-slow"></div>
        <span className="text-xs text-[var(--text-secondary)] font-mono">LIVE</span>
      </div>
    </header>
  );
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <Router>
      <div className="min-h-screen bg-[var(--bg-primary)] grid-bg">
        <Sidebar isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />
        
        <div className="lg:ml-64">
          <TopBar onMenuClick={() => setSidebarOpen(true)} />
          
          <main className="p-6">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tickets" element={<Tickets />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/tickets/:id" element={<TicketDetail />} />
              <Route path="/bot-status" element={<BotStatus />} />
              <Route path="/kanban" element={<KanbanBoard />} />
            </Routes>
          </main>
        </div>
      </div>
    </Router>
  );
}

export default App;
