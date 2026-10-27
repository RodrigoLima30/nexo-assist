import { describe, expect, it } from 'vitest';
import { addBusinessDays, addBusinessHours, computeDueAt, formatDue, slaStatus } from '@shared/sla';
import { classifyPriority } from '@shared/priority';

// 26/10/2026 é uma segunda-feira. Horários em BRT (UTC-3).
const brt = (s: string) => new Date(`${s}-03:00`);

describe('SLA em horário útil (seg–sex, 8h–18h BRT)', () => {
  it('soma 4 horas úteis dentro do mesmo dia', () => {
    expect(addBusinessHours(brt('2026-10-26T10:00:00'), 4)).toEqual(brt('2026-10-26T14:00:00'));
  });

  it('transborda para o dia útil seguinte', () => {
    expect(addBusinessHours(brt('2026-10-26T16:00:00'), 4)).toEqual(brt('2026-10-27T10:00:00'));
  });

  it('pula o fim de semana', () => {
    expect(addBusinessHours(brt('2026-10-30T17:00:00'), 4)).toEqual(brt('2026-11-02T11:00:00'));
  });

  it('conta a partir das 8h quando aberto fora do expediente', () => {
    expect(addBusinessHours(brt('2026-10-31T09:00:00'), 4)).toEqual(brt('2026-11-02T12:00:00'));
    expect(addBusinessHours(brt('2026-10-27T06:30:00'), 4)).toEqual(brt('2026-10-27T12:00:00'));
  });

  it('soma dias úteis mantendo o horário', () => {
    expect(addBusinessDays(brt('2026-10-22T14:00:00'), 3)).toEqual(brt('2026-10-27T14:00:00'));
  });

  it('crítica tem plantão 24h: 1 hora corrida, mesmo no sábado de madrugada', () => {
    expect(computeDueAt('critica', brt('2026-10-31T03:00:00'))).toEqual(brt('2026-10-31T04:00:00'));
  });

  it('marca como vencido um chamado médio sem atualização há 6 dias', () => {
    const now = brt('2026-10-27T10:00:00');
    const status = slaStatus({ priority: 'media', status: 'aguardando_analista', updatedAt: brt('2026-10-21T10:00:00').toISOString() }, now);
    expect(status.overdue).toBe(true);
    expect(status.ruleLabel).toBe('3 dias úteis');
  });

  it('chamado resolvido não tem prazo', () => {
    const status = slaStatus({ priority: 'alta', status: 'resolvido', updatedAt: brt('2026-10-01T10:00:00').toISOString() }, new Date());
    expect(status).toMatchObject({ dueAt: null, overdue: false });
  });

  it('formata o prazo de forma relativa ao dia', () => {
    const now = brt('2026-10-27T09:43:00');
    expect(formatDue(brt('2026-10-27T13:43:00').toISOString(), now)).toBe('13:43');
    expect(formatDue(brt('2026-10-28T10:00:00').toISOString(), now)).toBe('amanhã, 10:00');
    expect(formatDue(brt('2026-10-30T14:20:00').toISOString(), now)).toBe('30 out, 14:20');
  });
});

describe('classificação de prioridade (Anexo A)', () => {
  const base = { type: 'INC' as const, impact: 'self' as const, blocked: null, deadlineToday: null, hasWorkaround: null };

  it('crítica quando algo está parado para a equipe', () => {
    expect(classifyPriority({ ...base, impact: 'team', blocked: true }).priority).toBe('critica');
    expect(classifyPriority({ ...base, impact: 'company' }).priority).toBe('critica');
  });

  it('equipe afetada mas com alternativa não é crítica', () => {
    expect(classifyPriority({ ...base, impact: 'team', hasWorkaround: true }).priority).toBe('media');
  });

  it('alta quando há compromisso no mesmo dia (caso da VPN antes da reunião)', () => {
    const d = classifyPriority({ ...base, deadlineToday: true });
    expect(d.priority).toBe('alta');
    expect(d.reason).toContain('compromisso');
  });

  it('alta quando impede uma pessoa de trabalhar', () => {
    expect(classifyPriority({ ...base, blocked: true }).priority).toBe('alta');
  });

  it('média quando atrapalha mas há alternativa', () => {
    expect(classifyPriority({ ...base, hasWorkaround: true }).priority).toBe('media');
  });

  it('baixa para requisição sem urgência', () => {
    expect(classifyPriority({ ...base, type: 'REQ' }).priority).toBe('baixa');
  });

  it('requisição com prazo hoje sobe para alta', () => {
    expect(classifyPriority({ ...base, type: 'REQ', deadlineToday: true }).priority).toBe('alta');
  });
});
