import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut, MessageSquare, UserRound } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Avatar, NexoMark } from './common';

export function EmployeeShell({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <NexoMark size={20} />
          Nexo Assist
        </div>
        <nav className="nav">
          <NavLink to="/atendimento">
            <MessageSquare size={16} /> Atendimento
          </NavLink>
          <NavLink to="/perfil">
            <UserRound size={16} /> Meu perfil
          </NavLink>
        </nav>
        <div className="me">
          <Avatar name={user.name} size={34} />
          <div style={{ minWidth: 0 }}>
            <div className="name">{user.name}</div>
            <div className="email">{user.email}</div>
          </div>
        </div>
        <button
          type="button"
          className="logout"
          onClick={async () => {
            await logout();
            navigate('/entrar');
          }}
        >
          <LogOut size={16} /> Sair
        </button>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Service desk de TI <ChevronRight size={14} /> <b>{title}</b>
          </div>
          {right}
        </header>
        {children}
      </main>
    </div>
  );
}
