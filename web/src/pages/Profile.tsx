import { useState } from 'react';
import { Info, KeyRound, Lock, RotateCcwKey } from 'lucide-react';
import { EmployeeShell } from '../components/EmployeeShell';
import { useAuth } from '../lib/auth';

export function ProfilePage() {
  const { user } = useAuth();
  const [sent, setSent] = useState(false);
  if (!user) return null;
  return (
    <EmployeeShell title="Meu perfil">
      <div className="profile">
        <div className="content">
          <div>
            <h1>Meu perfil</h1>
            <div className="muted">Seus dados de acesso ao service desk de TI.</div>
          </div>
          <div className="panel">
            <div className="prow">
              <span className="pk">Nome</span>
              <span className="pv">{user.name}</span>
            </div>
            <div className="prow">
              <span className="pk">E-mail corporativo</span>
              <span className="pv">{user.email}</span>
              <span className="muted" style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12.5 }}>
                <Lock size={13} /> Gerenciado pela TI
              </span>
            </div>
            <div className="prow">
              <span className="pk">Departamento</span>
              <span className="pv">{user.department}</span>
            </div>
            {user.device && (
              <div className="prow">
                <span className="pk">Equipamento</span>
                <span className="pv">
                  {user.device} · {user.os}
                </span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="prow" style={{ padding: 24 }}>
              <span className="avatar" style={{ width: 40, height: 40, background: 'var(--desk)', color: 'var(--ink-2)' }}>
                <KeyRound size={18} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>Senha</div>
                <div className="muted" style={{ fontSize: 13.5 }}>
                  Alterada há 42 dias
                </div>
              </div>
              <button type="button" className="btn btn-outline" onClick={() => setSent(true)} disabled={sent}>
                <RotateCcwKey size={15} /> {sent ? 'Link enviado' : 'Redefinir senha'}
              </button>
            </div>
            <div className="helper">
              <Info size={14} />
              {sent ? `Link de redefinição enviado para ${user.email} (simulado).` : `Enviaremos um link de redefinição para ${user.email}.`}
            </div>
          </div>
        </div>
      </div>
    </EmployeeShell>
  );
}
