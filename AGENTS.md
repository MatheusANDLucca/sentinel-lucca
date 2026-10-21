# Diretrizes do Sentinel Lucca para Agentes de IA

Este documento define as regras de desenvolvimento, design e comunicação que devem ser seguidas rigorosamente ao trabalhar neste projeto.

## 1. Idioma Obrigatório
- Todas as respostas, mensagens de commit, documentações e comentários devem ser entregues em **Português do Brasil (pt-BR)**.

## 2. Diretrizes de Design & UI/UX
- Sempre utilize as imagens e o guia presentes na pasta [`inspiracoes/`](file:///inspiracoes/) para guiar a criação visual de qualquer nova ferramenta, tela ou componente adicionado ao projeto.
- Priorize:
  - Estética refinada e profissional (vide paletas e tipografias em `inspiracoes/`).
  - Cores consistentes e harmoniosas (evitar cores primárias genéricas).
  - Componentes limpos com espaçamento adequado e feedback interativo em hovers e cliques.
  - Manter consistência com a arquitetura existente (HTML semântico, Vanilla CSS modular e Vanilla JavaScript).

## 3. Arquitetura do Projeto
- **Backend:** Python com FastAPI, SQLite para persistência e Uvicorn.
- **Frontend:** Vanilla HTML5, CSS3 moderno e Vanilla JavaScript assíncrono (sem dependência de Tailwind ou frameworks pesados).
- **Módulos Atuais:**
  - CFTV (Monitoramento e status de câmeras)
  - Impressoras (Monitoramento SNMP e status de suprimentos)
  - RMA (Gestão de remessas, envio de e-mails com PDF e controle de garantia)
  - Portal Unificado (Dashboard central)
