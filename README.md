# Nexo Assist

Agent de atendimento do service desk de TI da Nexo (desafio técnico). O funcionário descreve o problema num chat e o agent decide se responde uma dúvida, consulta ou atualiza um chamado, abre um chamado novo ou chama um analista. O analista acompanha tudo num console, assume conversas (com o agent pausado) e devolve ou encerra.

- **Stack:** TypeScript estrito · React + Vite · Hono · Mastra (agent) · SQLite nativo do Node (`node:sqlite`) · Vitest
- **Três processos:** interface (Vite), API + agent (Hono) e o **serviço de chamados simulado**, que roda separado, com banco próprio e instabilidade simulada.

---

## Como rodar

Pré-requisito: **Node.js 22.13+** (testado no 24 LTS). Não há dependência nativa para compilar.

```bash
npm install
cp .env.example .env      # opcional — sem chave de LLM o agent roda no modo offline
npm run dev               # serviço de chamados :4100 · API :4000 · interface :5173
```

Abra **http://localhost:5173**. O login aceita **qualquer senha** para as contas do diretório (a tela tem atalhos):

| Conta | Perfil | Para testar |
|---|---|---|
| `ana.souza@nexo.com.br` | funcionária · Windows 11 | começa sem conversa; tem chamado vencido, em andamento, aprovado e um resolvido há 4 dias |
| `carla.mendes@nexo.com.br` | funcionária · Windows 10 | o artigo da VPN 809 **se aplica** a ela |
| `rafael.lima@nexo.com.br` | analista · Suporte N2 | console |
| `juliana.costa@nexo.com.br` | analista · Suporte N1 | console (testa a trava "outro analista já assumiu") |

Outros comandos:

```bash
npm test            # 49 testes: regras, serviço de chamados, cenários do agent e API
npm run typecheck   # tsc --noEmit (strict + noUncheckedIndexedAccess)
npm run eval        # avaliação rotulada do interpretador (usa o LLM se houver chave)
npm run reset       # apaga os bancos locais (pare os servidores antes); o seed recria tudo
npm run build && npm start   # modo produção: a API serve o front compilado em :4000
```

### Com LLM

No `.env`, configure `ANTHROPIC_API_KEY` (padrão `NEXO_MODEL=anthropic/claude-haiku-5-5`). O modelo usa o *model router* do Mastra, então trocar de provedor é só configuração (ex.: `NEXO_MODEL=openai/gpt-5-mini` + `OPENAI_API_KEY`). Sem chave, ou com `NEXO_OFFLINE=true`, o interpretador offline assume. A interface mostra em cada resposta qual interpretador foi usado.

### Roteiro sugerido (≈5 min)

1. **Ana** → "Meu notebook não conecta na VPN desde ontem. Aparece o erro 809." → o agent consulta os chamados, vê que o artigo do 809 só vale para Windows 10 e pergunta quem é afetado (Tela 2).
2. "Só eu. Tenho reunião com um cliente às 14h" → prioridade **alta** pela reunião, prazo de 4 h úteis, rascunho para confirmar → **Confirmar** (ou Ctrl/⌘+Enter) cria o INC. Clique em **Por quê?** em qualquer resposta.
3. "Qual o status do meu chamado?" → seleção entre os abertos → INC-20311 está **vencido** → **Falar com um analista** (Tela 3). A conversa vai para a fila do N2 e o agent pausa.
4. Saia e entre como **Rafael** → a conversa aparece em "Para você" com o resumo do agent → **Assumir atendimento**, responda, **Devolver ao agent** ou **Encerrar** (Telas 4 e 5).
5. Outros casos: "Como está o REQ-10447?" (chamado de outra pessoa → negado), "Meu notebook continua lento" (vira **atualização** do INC-20311, sem duplicar), "A senha do SAP bloqueou de novo" (propõe **reabrir** o INC-20150), "Como marco minhas férias?" (fora de escopo → RH), "Qual o horário do service desk?" (resolve sem chamado), duas mensagens sem sentido seguidas (agent sem segurança → analista).

---

## Arquitetura

```
 web/ (React)                 server/app (Hono)                      server/tickets-service (Hono)
 ┌──────────────┐  HTTP/SSE  ┌───────────────────────────────┐  HTTP  ┌───────────────────────────┐
 │ Login        │──────────▶│ auth · rate limit · SSE       │──────▶│ /tickets (token de serviço)│
 │ Chat         │           │ ConversationService           │ retry │ privacidade por solicitante│
 │ Console      │◀──────────│   modos: agent / fila /       │ idemp.│ idempotência · reabertura  │
 └──────────────┘  polling  │   analista / encerrada        │       │ 503 simulado (legado)      │
                            │ AgentEngine ─▶ Interpreter    │       │ SQLite próprio (tickets.db)│
                            │   │            (Mastra LLM    │       └───────────────────────────┘
                            │   │             ou offline)   │
                            │   ├─ regras (shared/)         │
                            │   ├─ central de ajuda         │
                            │   └─ TicketsClient            │
                            │ SQLite (nexo.db): sessões,    │
                            │ conversas, estado, mensagens  │
                            └───────────────────────────────┘
```

| Pasta | Responsabilidade |
|---|---|
| `shared/` | Vocabulário do Anexo A (tipos, categorias, prioridades, status), **regra de prioridade**, **SLA em horário útil** e os contratos de chat. Usado pelo front, pela API e pelo serviço. |
| `server/tickets-service/` | Serviço de chamados "legado", **processo separado**: repositório, API, seed. Nunca devolve um chamado para quem não o abriu. |
| `server/clients/` | Cliente HTTP do serviço: timeout, retry com backoff em 503/rede, `Idempotency-Key` nas escritas. |
| `server/agent/` | O agent: `engine.ts` (decisão e fluxos), `interpreter/` (LLM via Mastra e offline), `tracer.ts` (trilha), `handoff.ts` (resumo para o analista). |
| `server/helpcenter/` | 8 artigos curtos com condições de aplicabilidade e busca lexical. |
| `server/app/` | API: sessões, `ConversationService` (regras de modo/pausa/limite, independentes de HTTP), rotas, SSE, seed das conversas de exemplo. |
| `web/src/` | Telas do protótipo e componentes (cards, rascunho, seletor, painel de decisão). |

---

## Como o agent decide

**Princípio: o LLM entende, o código decide.** O LLM não escolhe a ação nem calcula prioridade ou prazo. Ele lê a mensagem e devolve um JSON validado por schema (Zod) com a intenção, os fatos (categoria, tipo, impacto, se a pessoa está parada, compromisso hoje, chamado citado, chamado relacionado, artigo aplicável…) e um grau de confiança. O motor aplica as regras do Anexo A em código. Assim as decisões ficam auditáveis, testáveis e baratas.

A cada mensagem:

1. **Contexto (barato, sem LLM):** chamados do funcionário (abertos e resolvidos há ≤ 7 dias) e os 3 artigos mais próximos da central.
2. **Interpretação:** **uma** chamada curta ao LLM, com `temperature: 0`, timeout de 15 s e contexto compacto. Se o provedor falhar, cai no interpretador offline e a trilha registra `fallback`.
3. **Sanitização:** número de chamado precisa ter formato válido, chamado relacionado precisa estar entre os do funcionário e artigo precisa existir. Nada que o LLM "inventar" passa.
4. **Política** (ordem de precedência):
   - pedido de analista ou assunto fora de TI valem em qualquer ponto da conversa;
   - **confiança < 50% → o agent pergunta** em vez de agir; **duas vezes seguidas → transfere** com o motivo "agent sem segurança" e a confiança;
   - resposta a uma pergunta pendente (impacto, urgência, seleção de chamado, informação a acrescentar, sim/não);
   - fluxos por intenção.
5. **Abertura de chamado:** checa **duplicidade** (aberto → propõe **atualizar**; resolvido há ≤ 7 dias → propõe **reabrir**), depois a **central de ajuda** (se o artigo se aplica ao equipamento da pessoa, sugere antes de abrir), pergunta **só o que falta** (quem é afetado; urgência) e então classifica prioridade, calcula o prazo e mostra o **rascunho**. Nada é criado ou alterado sem o clique em Confirmar.
6. **Transferência:** quando o funcionário pede, em caso crítico (cria e já transfere ao N2), com chamado vencido (o agent oferece) ou sem segurança. Leva um **resumo do caso** para o analista, marca o chamado no sistema legado e coloca a conversa em "aguardando atendente". Dali em diante o agent não responde.

**Cliques não gastam LLM.** Opções rápidas, seleção de chamado e confirmação do rascunho chegam como ações estruturadas (`ClientAction`), e a intenção já é conhecida.

**Prioridade** (`shared/priority.ts`): equipe/empresa afetada sem alternativa → Crítica; compromisso hoje ou pessoa impedida de trabalhar → Alta; incidente com alternativa → Média; pedido sem urgência → Baixa.
**Prazo** (`shared/sla.ts`): conta a partir da última atualização, em horário útil (seg–sex, 8h–18h, BRT), e a Crítica conta 1 h corrida (plantão 24 h).

### Transparência

Acima de cada resposta aparecem as ações executadas ("consultou seus chamados · buscou na central de ajuda · classificou a prioridade…"), transmitidas em tempo real enquanto o agent trabalha. O botão **Por quê?** abre a trilha completa:

- **O que entendi** (frase + intenção) e os **fatos considerados**;
- **Ação** escolhida e **segurança** (barra + %, e quem interpretou: LLM, offline, clique ou fallback);
- **Por quê** (raciocínio) e as **regras do service desk aplicadas**, citando o Anexo A;
- **Passos**: ferramenta, duração, resultado, entrada/saída e erros (ex.: "3 tentativas" quando o legado oscilou);
- latência total, modelo e tokens.

O analista vê a mesma trilha no console, além do resumo da transferência.

---

## Como garanti a qualidade das decisões

- **Regras como funções puras e testadas:** prioridade e SLA (horário útil, fim de semana, fora do expediente, plantão).
- **Testes de cenário ponta a ponta** (`tests/agent-scenarios.test.ts`): o motor conversa com o **serviço de chamados real** (em memória, pelo contrato HTTP) e cobre a Tela 2 completa, caso crítico, artigo que se aplica e que não se aplica, cancelamento, duplicidade, reabertura, consulta com seleção, consulta pelo assunto sem número, vencido + transferência, **privacidade**, sistema legado fora do ar, complemento, dúvida, escopo e baixa confiança.
- **Testes de API** (`tests/api.test.ts`): perfis, isolamento entre funcionários, streaming, pausa do agent com analista, assumir/responder/devolver/encerrar, trava entre dois analistas, **persistência após reinício** e limite de mensagens.
- **Avaliação rotulada** (`npm run eval`): 23 frases com intenção e fatos esperados. Com chave, mede o LLM real. Ressalva honesta: as heurísticas offline foram ajustadas olhando esses mesmos casos, então os 100% do modo offline não medem generalização. O valor do eval está em comparar modelos e prompts no modo LLM.
- **Defesa em profundidade:** schema na saída do LLM, sanitização antes de usar, regras em código, confirmação humana antes de qualquer escrita.

---

## Escolha do modelo

**Claude Haiku 5.5** (`anthropic/claude-haiku-5-5`) via Mastra. A tarefa do LLM aqui é estreita (classificar e extrair num JSON pequeno), então um modelo rápido e barato basta. Latência baixa importa num chat, e o custo por conversa fica em uma chamada curta por mensagem livre (cliques não chamam o LLM; o contexto é limitado a 6 mensagens e 3 artigos; saída limitada a 700 tokens). O *model router* do Mastra deixa o provedor configurável. E o **modo offline** garante que o projeto roda, é testável e degrada com elegância se o provedor cair.

> **Limitação honesta:** no ambiente em que desenvolvi não havia chave de API. O caminho LLM foi validado por typecheck contra os tipos do Mastra e pelo fallback, mas a bateria de testes e o roteiro manual rodaram com o interpretador offline. Com uma chave, `npm run eval` mede o modelo.

---

## Persistência, resiliência e segurança

- **Persistência:** conversas, mensagens (com a trilha), o estado de trabalho do agent (pergunta pendente, rascunho, chamado em foco) e o modo de cada conversa ficam no SQLite da API; os chamados ficam no SQLite do serviço. Tudo sobrevive a reinício, e o funcionário retoma a conversa de onde parou (história 6).
- **Sistema legado instável:** `TICKETS_FAILURE_RATE=0.1` faz o serviço responder 503 em 10% das chamadas. O cliente repete com backoff; as escritas usam `Idempotency-Key = conversa:rascunho`, então repetir **nunca duplica** um chamado (o duplo clique também não). Se ainda assim falhar, o agent avisa e o rascunho continua pendente.
- **Privacidade:** o e-mail do solicitante vem **sempre da sessão**, nunca do LLM. O serviço filtra por solicitante (chamado de outra pessoa = 404). O funcionário só lê as próprias conversas, e os perfis funcionário/analista são separados no servidor.
- **Chaves e abuso:** chaves só no `.env` (fora do git). Cookie de sessão `HttpOnly`/`SameSite=Lax` (`Secure` em produção). Limite de taxa no login e no chat, limite de 30 mensagens por conversa, uma resposta por vez por conversa, limite de corpo e headers de segurança.

---

## Principais trade-offs

- **Motor determinístico + LLM como intérprete, em vez de deixar o LLM orquestrar ferramentas livremente.** Ganho: regras garantidas, testes estáveis, custo e latência previsíveis, trilha fácil de explicar. Perda: conversas muito fora do roteiro dependem de fluxos que eu previ. Mitigação: confiança baixa leva a pergunta e depois a analista.
- **Chamado vencido:** o Anexo A lista "chamados vencidos" como motivo de transferência; segui o protótipo (Tela 3) e o agent **oferece** o analista em vez de transferir sozinho. Um clique transfere e a transferência já vai para o N2.
- **Polling (3 s) em vez de WebSocket** para o console e para o funcionário em fila: simples e robusto para o volume do desafio. As respostas do agent são em streaming (SSE).
- **Busca lexical na central:** com 8 artigos, embeddings seriam exagero. A aplicabilidade (ex.: "só Windows 10") é checada contra o equipamento do funcionário.
- **SLA sem feriados** e com horário fixo de Brasília.
- **Login de demonstração:** qualquer senha para contas do diretório, como pede o PRD.
- O dev usa `node --watch --import tsx`: o `tsx watch` travou na inicialização concorrente no Windows.

## Deploy

Não publiquei. Para publicar faria assim: build único (`npm run build && npm start`, a API já serve o front) num serviço com disco persistente (Railway/Fly.io/Render) para os dois SQLite, o serviço de chamados como segundo processo/serviço privado, chave do LLM como *secret*, `NODE_ENV=production` (cookie `Secure`), e os limites atuais (taxa, 30 mensagens, uma resposta por vez) mais um teto diário de tokens.

## O que faria com mais tempo

- Rodar e ajustar o eval com o LLM real, aumentar o conjunto rotulado com frases de usuários e medir regressão a cada mudança de prompt.
- Deixar o LLM redigir as respostas (hoje são modelos de texto em código) mantendo as regras no motor.
- Histórico de eventos do chamado visível ao funcionário; notificação quando o analista responde.
- WebSocket/SSE para o console; métricas reais (tempo de primeira resposta, % resolvido sem fila) no lugar dos números ilustrativos do login.
- Feriados no SLA, SSO real, Postgres para várias instâncias e rate limit distribuído.
