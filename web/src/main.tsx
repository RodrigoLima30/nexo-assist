import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { Role } from '@shared/domain';
import { Spinner } from './components/common';
import { AuthProvider, useAuth } from './lib/auth';
import { ChatPage } from './pages/Chat';
import { ConsolePage } from './pages/Console';
import { LoginPage } from './pages/Login';
import { ProfilePage } from './pages/Profile';
import './styles.css';

function home(role: Role): string {
  return role === 'analyst' ? '/console' : '/atendimento';
}

function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="center-fill">
        <Spinner dark />
      </div>
    );
  }
  if (!user) return <Navigate to="/entrar" replace />;
  if (user.role !== role) return <Navigate to={home(user.role)} replace />;
  return <>{children}</>;
}

function Root() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="center-fill">
        <Spinner dark />
      </div>
    );
  }
  return <Navigate to={user ? home(user.role) : '/entrar'} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/entrar" element={<LoginPage />} />
          <Route
            path="/atendimento"
            element={
              <Guard role="employee">
                <ChatPage />
              </Guard>
            }
          />
          <Route
            path="/perfil"
            element={
              <Guard role="employee">
                <ProfilePage />
              </Guard>
            }
          />
          <Route
            path="/console"
            element={
              <Guard role="analyst">
                <ConsolePage />
              </Guard>
            }
          />
          <Route path="*" element={<Root />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
