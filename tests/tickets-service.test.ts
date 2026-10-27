import { describe, expect, it } from 'vitest';
import { TicketsUnavailableError, type CallInfo } from '../server/clients/tickets-client';
import { makeTicketsStack, TOKEN } from './helpers';

const ANA = 'ana.souza@nexo.com.br';
const CARLA = 'carla.mendes@nexo.com.br';

const newTicket = {
  type: 'INC' as const,
  title: 'VPN não conecta — erro 809',
  description: 'Notebook com Windows 11 não conecta na VPN, erro 809.',
  category: 'Rede e VPN' as const,
  priority: 'alta' as const,
  affected: 'self' as const,
  requesterEmail: ANA,
};

describe('serviço de chamados', () => {
  it('lista só os chamados do próprio solicitante', async () => {
    const { client } = makeTicketsStack();
    const open = await client.listMine(ANA, 'open');
    expect(open.map((t) => t.id).sort()).toEqual(['INC-20298', 'INC-20311', 'REQ-10442']);
    expect(open.every((t) => t.requesterEmail === ANA)).toBe(true);
  });

  it('não expõe chamado de outra pessoa (privacidade)', async () => {
    const { client } = makeTicketsStack();
    expect(await client.get('REQ-10447', ANA)).toBeNull();
    expect((await client.get('REQ-10447', CARLA))?.title).toContain('SAP');
  });

  it('exige o token de serviço', async () => {
    const { app } = makeTicketsStack();
    const res = await app.request(`/tickets?requester=${ANA}`);
    expect(res.status).toBe(401);
    const ok = await app.request(`/tickets?requester=${ANA}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
  });

  it('cria chamado com numeração do tipo e é idempotente', async () => {
    const { client } = makeTicketsStack();
    const a = await client.create(newTicket, 'Nexo Assist', 'draft-D-1');
    const b = await client.create(newTicket, 'Nexo Assist', 'draft-D-1');
    expect(a.id).toMatch(/^INC-\d{5}$/);
    expect(b.id).toBe(a.id);
    const open = await client.listMine(ANA, 'open');
    expect(open.filter((t) => t.title === newTicket.title)).toHaveLength(1);
  });

  it('rejeita chamado incompleto', async () => {
    const { client } = makeTicketsStack();
    await expect(client.create({ ...newTicket, title: '' }, 'x', 'k')).rejects.toMatchObject({ status: 400 });
  });

  it('reabre resolvido há até 7 dias e recusa os mais antigos', async () => {
    const { client } = makeTicketsStack();
    const reopened = await client.reopen('INC-20150', ANA, 'Voltou a bloquear.', 'Nexo Assist', 'k1');
    expect(reopened.status).toBe('aguardando_analista');
    await expect(client.reopen('INC-19877', ANA, 'Voltou.', 'Nexo Assist', 'k2')).rejects.toMatchObject({ status: 409 });
  });

  it('adiciona informação e atualiza a data de atualização', async () => {
    const { client } = makeTicketsStack();
    const before = await client.get('INC-20311', ANA);
    const after = await client.comment('INC-20311', ANA, 'Agora trava ao abrir o Excel.', 'Nexo Assist', 'c1');
    expect(after.events.at(-1)?.text).toContain('Excel');
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before!.updatedAt).getTime());
  });

  it('repete em falhas transitórias (503) e reporta as tentativas', async () => {
    let calls = 0;
    const { client } = makeTicketsStack({ failureRate: 0.5, random: () => (calls++ < 2 ? 0 : 1) });
    const info: CallInfo = { attempts: 0 };
    const open = await client.listMine(ANA, 'open', info);
    expect(open.length).toBe(3);
    expect(info.attempts).toBe(3);
  });

  it('desiste depois das retentativas com erro claro', async () => {
    const { client } = makeTicketsStack({ failureRate: 1 });
    await expect(client.listMine(ANA, 'open')).rejects.toBeInstanceOf(TicketsUnavailableError);
  });
});
