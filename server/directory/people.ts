import type { Person } from '@shared/domain';

/**
 * Diretório de pessoas (simulado). Em produção viria do Active Directory / IdP.
 * O login aceita qualquer senha para estas contas, como pede o PRD.
 */
export const PEOPLE: readonly Person[] = [
  {
    email: 'ana.souza@nexo.com.br',
    name: 'Ana Souza',
    role: 'employee',
    department: 'Financeiro',
    device: 'Notebook Dell Latitude 5440',
    os: 'Windows 11',
  },
  {
    email: 'carla.mendes@nexo.com.br',
    name: 'Carla Mendes',
    role: 'employee',
    department: 'Comercial',
    device: 'Notebook Lenovo ThinkPad E14',
    os: 'Windows 10',
  },
  {
    email: 'bruno.tavares@nexo.com.br',
    name: 'Bruno Tavares',
    role: 'employee',
    department: 'Logística',
    device: 'Desktop HP ProDesk 400',
    os: 'Windows 11',
  },
  {
    email: 'diego.ramos@nexo.com.br',
    name: 'Diego Ramos',
    role: 'employee',
    department: 'Marketing',
    device: 'MacBook Air M2',
    os: 'macOS',
  },
  {
    email: 'elisa.prado@nexo.com.br',
    name: 'Elisa Prado',
    role: 'employee',
    department: 'Jurídico',
    device: 'Notebook Dell Latitude 3420',
    os: 'Windows 10',
  },
  {
    email: 'fabio.nunes@nexo.com.br',
    name: 'Fábio Nunes',
    role: 'employee',
    department: 'Engenharia',
    device: 'Notebook Dell Precision 5570',
    os: 'Windows 11',
  },
  {
    email: 'gabriela.rocha@nexo.com.br',
    name: 'Gabriela Rocha',
    role: 'employee',
    department: 'RH',
    device: 'Notebook Lenovo ThinkPad E14',
    os: 'Windows 11',
  },
  {
    email: 'rafael.lima@nexo.com.br',
    name: 'Rafael Lima',
    role: 'analyst',
    department: 'Service desk de TI',
    team: 'Suporte N2',
  },
  {
    email: 'juliana.costa@nexo.com.br',
    name: 'Juliana Costa',
    role: 'analyst',
    department: 'Service desk de TI',
    team: 'Suporte N1',
  },
];

export function findPerson(email: string): Person | undefined {
  const e = email.trim().toLowerCase();
  return PEOPLE.find((p) => p.email === e);
}

export function requirePerson(email: string): Person {
  const p = findPerson(email);
  if (!p) throw new Error(`Pessoa desconhecida: ${email}`);
  return p;
}
