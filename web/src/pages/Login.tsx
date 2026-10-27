import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react';
import { Dot, NexoMark, Spinner } from '../components/common';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

const DEMO = [
  { email: 'ana.souza@nexo.com.br', label: 'Ana · funcionária (Windows 11)' },
  { email: 'carla.mendes@nexo.com.br', label: 'Carla · funcionária (Windows 10)' },
  { email: 'rafael.lima@nexo.com.br', label: 'Rafael · analista N2' },
  { email: 'juliana.costa@nexo.com.br', label: 'Juliana · analista N1' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Informe seu e-mail corporativo e a senha.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const user = await login(email.trim(), password);
      navigate(user.role === 'analyst' ? '/console' : '/atendimento', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <section className="showcase" aria-hidden="true">
        <div className="brand">
          <NexoMark size={24} color="#fff" /> Nexo Assist
        </div>
        <div>
          <div className="eyebrow">Service desk de TI da Nexo</div>
          <h1>Seu problema de TI, resolvido em uma conversa.</h1>
          <p className="lead">Descreva o que está acontecendo. O assistente consulta seus chamados, busca na central de ajuda e chama um analista quando precisa.</p>
          <div className="preview">
            <div className="u">Meu notebook não conecta na VPN. Erro 809.</div>
            <div className="who">
              Nexo Assist<span>consultou seus chamados · criou um chamado</span>
            </div>
            <div className="a">Pronto: abri o chamado com prioridade alta. Um analista fala com você em até 4 h úteis.</div>
            <div className="chip">
              <Dot color="var(--warning)" />
              <b>INC-20517</b>
              <span style={{ color: 'var(--ink-3)' }}>Rede e VPN · Alta · em até 4 h</span>
            </div>
          </div>
        </div>
        <div className="stats">
          <div>
            <span className="n">8 s</span>
            <span className="l">primeira resposta, em média</span>
          </div>
          <div>
            <span className="n">72%</span>
            <span className="l">resolvidos sem fila</span>
          </div>
          <div>
            <span className="n">
              6 <Dot color="var(--success)" size={8} />
            </span>
            <span className="l">analistas online agora</span>
          </div>
        </div>
      </section>

      <section className="signin">
        <div className="help">
          Problema para entrar? <b>Ligue no ramal 4000</b>
        </div>
        <form onSubmit={submit} noValidate>
          <div>
            <h2>Entrar</h2>
            <p className="sub">Use seu e-mail corporativo e a senha da rede Nexo.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="field">
              <div className="label-row">
                <label htmlFor="email">E-mail corporativo</label>
              </div>
              <div className="input">
                <Mail size={16} />
                <input id="email" type="email" autoComplete="username" placeholder="nome.sobrenome@nexo.com.br" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <div className="label-row">
                <label htmlFor="password">Senha</label>
                <a href="#" onClick={(e) => e.preventDefault()} title="No ambiente de demonstração qualquer senha funciona">
                  Esqueci minha senha
                </a>
              </div>
              <div className="input">
                <LockKeyhole size={16} />
                <input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="icon-btn" style={{ width: 30, height: 30, borderRadius: 6 }} onClick={() => setShow((v) => !v)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <label className="remember" onClick={() => setRemember((v) => !v)}>
              <span className={`checkbox${remember ? ' on' : ''}`} role="checkbox" aria-checked={remember}>
                {remember && <Check size={12} strokeWidth={3} />}
              </span>
              Manter conectado neste computador
            </label>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary submit" disabled={loading}>
            {loading ? <Spinner /> : null} Entrar {!loading && <ArrowRight size={16} />}
          </button>
          <div className="demo-accounts">
            <span>Ambiente de demonstração — qualquer senha funciona. Entrar como:</span>
            <div className="list">
              {DEMO.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword('demo');
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </form>
        <div className="footer">
          <span>© 2026 Nexo · Service desk de TI</span>
          <span>Privacidade e uso de dados</span>
        </div>
      </section>
    </div>
  );
}
