# BarberSync - Multi-tenant com Super Admin e WhatsApp (Evolution API)

Sistema SaaS: um só deploy atende varias barbearias. Voce (super admin)
cadastra cada barbearia e o login do gestor dela; cada gestor so enxerga
os dados da propria loja; cada barbearia conecta seu proprio WhatsApp
para confirmar agendamentos automaticamente. Tudo no fuso de Brasilia.

## Estrutura de acesso

| Quem | Onde loga | O que ve/controla |
|---|---|---|
| **Voce (super admin)** | `/superadmin` | Cria/edita/suspende barbearias, cria/reseta login dos gestores, define vencimento da assinatura |
| **Gestor da barbearia** | `/admin` | Só os dados da própria loja: serviços, barbeiros, agendamentos, clientes, horário de funcionamento, conexão do WhatsApp |
| **Cliente final** | `/<link-da-barbearia>` (ex: `/barbearia-do-joao`) | Agenda um horário — sem login |

O login é único (`/api/auth/login`): o sistema detecta sozinho se o email
é de super admin ou de gestor e devolve o token certo.

## O que mudou desde a versão anterior (single-tenant)

- Banco agora tem `tenants` (barbearias), `super_admins` e `managers`
  (antes era só uma tabela `admins`). Todo o resto (`services`, `barbers`,
  `bookings`, `users`, `settings`) ganhou uma coluna `tenant_id` e é
  isolado por barbearia.
- **Isso é uma mudança de schema.** Se você já tinha subido a versão
  anterior com dados reais, me avise antes de trocar — precisa de um
  script de migração para não perder nada. Se ainda está em teste, pode
  simplesmente substituir os arquivos.
- O webhook fixo do n8n (`WEBHOOK_URL`) saiu. Agora o próprio servidor
  manda a confirmação por WhatsApp, usando o número que o gestor conectou
  na aba WhatsApp do painel dele.
- Todo cálculo de "hoje"/"agora" no front-end (calendário, horário de
  funcionamento, filtros de data no painel) agora força o fuso horário de
  Brasília, não importa o fuso do celular/computador de quem está usando.

## Variáveis de ambiente (`.env`)

```
PORT=3000
JWT_SECRET=troque-por-um-valor-aleatorio-grande
SUPERADMIN_EMAIL=voce@seudominio.com
SUPERADMIN_PASSWORD=troque-esta-senha
EVOLUTION_API_URL=https://sua-evolution-api.seudominio.com
EVOLUTION_API_KEY=sua-chave-global-da-evolution-api
EVOGO_API_URL=https://sua-evolution-go.seudominio.com
EVOGO_API_KEY=global-api-key-da-evolution-go
PUBLIC_BASE_URL=https://seu-dominio-do-barbersync.com
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

- `SUPERADMIN_EMAIL`/`SUPERADMIN_PASSWORD`: só são usados para criar o
  super admin automaticamente na **primeira vez** que o servidor sobe
  (se a tabela já tiver algum super admin, essas variáveis são ignoradas).
- `EVOLUTION_API_URL`/`EVOLUTION_API_KEY`: sua Evolution API self-hosted.
  `EVOLUTION_API_KEY` é a chave global do servidor Evolution (a mesma
  usada nos seus outros projetos com WhatsApp). Sem essas duas variáveis
  preenchidas, o sistema continua funcionando normalmente (agendamento,
  painel, etc.) só que sem enviar WhatsApp - o botão "Conectar WhatsApp"
  avisa que não está configurado.

## Como usar, passo a passo

1. `npm install`, copie `.env.example` para `.env` e preencha as variáveis acima.
2. `node server.js`.
3. Acesse `/superadmin`, entre com `SUPERADMIN_EMAIL`/`SUPERADMIN_PASSWORD`.
4. Clique em "Nova Barbearia": preencha nome, email e senha do gestor
   (o link/slug é gerado automaticamente a partir do nome, mas dá pra
   editar). Isso já cria o login do gestor.
5. Mande pro dono da barbearia o link `/admin` (login) e o link público
   dele (`/<slug-da-loja>`), pra ele divulgar pros clientes.
6. O gestor entra em `/admin`, cadastra os serviços e barbeiros dele, e
   na aba **WhatsApp** clica em "Conectar WhatsApp", escaneia o QR code
   com o celular da barbearia. A partir daí, toda confirmação de
   agendamento sai automaticamente por aquele número.
7. Quando quiser suspender ou reativar uma barbearia (ex: não pagou a
   mensalidade), é só usar o botão "Suspender"/"Reativar" no
   `/superadmin` - o painel do gestor e a página pública daquela loja
   ficam bloqueados até você reativar. O campo "Assinatura válida até"
   também bloqueia automaticamente no dia seguinte ao vencimento, mesmo
   que você esqueça de suspender manualmente.

## Estrutura de pastas

Tudo numa pasta só (sem subpastas de código) — mais fácil de navegar e copiar:

```
barbershop-app/
  server.js            -> ponto de entrada, monta as rotas e o roteamento por slug

  db.js                 -> schema multi-tenant e seeds
  auth.js                -> JWT com papel (superadmin/manager) e tenant_id
  tenant.js                -> checa se a barbearia está ativa (não suspensa/vencida)
  events.js                  -> realtime (SSE) por barbearia
  evolution.js                 -> cliente HTTP da Evolution API
  whatsapp.js                    -> monta e envia a mensagem de confirmação
  phone.js                         -> normaliza telefone (evita cliente duplicado)

  route-auth.js         -> login único (super admin ou gestor)
  route-superadmin.js     -> CRUD de barbearias e gestores (só super admin)
  route-services.js         -> serviços (gestor, isolado por tenant)
  route-barbers.js            -> barbeiros + upload de foto (gestor, isolado por tenant)
  route-bookings.js             -> agendamentos - listar/status/excluir (gestor)
  route-settings.js               -> horário de funcionamento (gestor)
  route-clients.js                  -> clientes (gestor)
  route-whatsapp.js                   -> conectar/desconectar WhatsApp, editar template (gestor)
  route-events.js                       -> SSE (gestor)
  route-public.js                         -> rotas públicas por slug (cliente final, sem login)

  superadmin.html    -> painel do super admin
  admin.html            -> painel do gestor (+ aba WhatsApp)
  client.html             -> página de agendamento do cliente (lê o slug pela URL)

  data/                          -> banco SQLite (precisa ser persistente)
  uploads/barbers/                 -> fotos dos barbeiros (precisa ser persistente)
```

`data/` e `uploads/barbers/` continuam sendo pastas porque são onde o servidor *guarda arquivos* (banco de dados e fotos) — isso é armazenamento, não código, e o servidor já cria essas pastas sozinho se não existirem.

## Deploy no EasyPanel

Igual ao anterior: crie o app apontando pro `Dockerfile`, configure as
variáveis de ambiente da lista acima, e configure dois volumes
persistentes:
- `/app/data` -> banco SQLite
- `/app/uploads` -> fotos dos barbeiros

## Sobre a Evolution API

Uma instância (`instance_name`) é criada por barbearia, usando o
`slug` dela como nome. O sistema chama os endpoints padrão da Evolution
API v2 self-hosted (`/instance/create`, `/instance/connect/:nome`,
`/instance/connectionState/:nome`, `/message/sendText/:nome`), sempre
com o header `apikey` = `EVOLUTION_API_KEY`. Se seu servidor Evolution
usa autenticação por instância em vez de uma chave global única, me
avise que eu ajusto `evolution.js`.

## Atendente IA no WhatsApp (plano PRO)

- O super admin define o plano de cada barbearia (**Básico** ou **PRO**) em `/superadmin`.
- No painel do gestor (aba Marketing), o card **Atendente IA no WhatsApp** só libera para PRO.
- Fluxo: cliente manda mensagem ou áudio -> áudio é transcrito pela OpenAI -> a IA oferece o
  link de agendamento ou agenda ali mesmo: confirma nome completo e telefone (cliente já
  cadastrado é reconhecido pelo número e não precisa informar de novo), lista profissionais,
  serviços (pode escolher vários), horários livres, mostra o resumo e só grava após o "sim".
- O agendamento entra no painel do gestor em tempo real, com a marca "Agendado pela IA no
  WhatsApp", e o cliente recebe a mesma mensagem de confirmação configurada na aba WhatsApp.
- Vários serviços viram um agendamento só (nome "Corte + Barba", valor e duração somados),
  igual aos pacotes.
- Se o gestor responder o cliente manualmente pelo celular, a IA pausa naquele chat por 1 hora.
- O webhook é configurado sozinho na Evolution ao conectar o WhatsApp e ao salvar o card da IA:
  `POST /api/webhook/evolution/<instancia>/<segredo>` (segredo derivado do `JWT_SECRET`).
- `PUBLIC_BASE_URL` é a URL pública do sistema (usada no webhook e no link enviado ao cliente).
  Sem ela, o sistema usa o endereço que o gestor estiver acessando.

## Dois motores de WhatsApp: Evolution API v2 e Evolution GO

- Em `/superadmin`, cada barbearia tem o campo **Motor do WhatsApp**: Evolution API v2 (padrão)
  ou Evolution GO. Dá pra usar os dois ao mesmo tempo, uma barbearia em cada.
- Tudo passa por `wa-provider.js`: confirmação, lembrete, atendente IA, QR code e status.
- **Evolution GO:** preencha `EVOGO_API_URL` e `EVOGO_API_KEY` (a `GLOBAL_API_KEY` do servidor GO).
  O sistema cria a instância, guarda o token dela no banco e registra o webhook no próprio
  `/instance/connect`. O servidor GO precisa estar com a licença ativada (senão responde 503).
- **Trocar o motor de uma barbearia:** mude no super admin e peça pro gestor clicar em
  "Conectar WhatsApp" de novo. A instância antiga é desligada e o QR do novo motor aparece.

## Botões e listas (plano PRO)

- Card do atendente IA: "Usar botões" (escolhas rápidas) e o seletor de formato
  (Texto numerado, Enquete ou Lista) para profissional, serviços e horários.
- Botões funcionam no Evolution GO atualizado (0.7.x). Na Evolution 2.3.7 dão erro e viram texto.
- Se o envio der erro, a IA manda as mesmas opções em texto numerado automaticamente.

## Enquetes (plano PRO) — recomendado

- Card do atendente IA → "Usar enquetes para o cliente escolher".
- A IA manda enquete para: primeiro contato (agendar aqui / receber link), profissional,
  serviços (marcar vários), horários (até 12) e confirmação.
- Enquete é recurso normal do WhatsApp: aparece em qualquer celular (diferente de botões/listas).
- Voto: Evolution v2 já entrega o nome da opção; Evolution GO grava o voto decifrado e o
  BarberSync consulta `/polls/:id/results` (precisa do Postgres do GO configurado).
- Com enquete escolhida, os botões (se ligados) continuam nas escolhas rápidas.

## Atendimento organizado e gestão do agendamento pelo WhatsApp (PRO)

- Configuração recomendada: "Usar botões" ligado + formato "Lista".
- Fluxo: botões (agendar aqui / link) → nome e número (botões) → profissional (lista) →
  serviços (lista + botões "Mais um serviço"/"Só isso") → data (lista com dias livres) →
  horário (lista separada em Manhã/Tarde/Noite) → resumo + botões Sim/Não.
- Cliente que volta e tem horário marcado recebe o resumo com os botões
  ✅ Confirmar presença · 🔄 Reagendar · ❌ Cancelar (se a IA não mostrar, o sistema mostra).
  - Confirmar: grava `client_confirmed_at` (selo "Cliente confirmou presença" no painel).
  - Reagendar: mesmo profissional e serviços; o próprio horário conta como livre.
  - Cancelar: pede confirmação; grava `cancelled_by = cliente_whatsapp`.
- A IA só mexe em agendamentos do próprio cliente, futuros e confirmados.

## Menu principal do WhatsApp (PRO)

- Enviado pelo sistema (sempre igual) quando o cliente manda saudação depois de 30 min sem
  conversa, ou digita "menu" a qualquer momento. Mensagens que já são um pedido
  ("quero cortar amanhã") vão direto para a IA.
- Opções: 📅 Agendar horário · 🗓️ Meus agendamentos · ✂️ Serviços e preços ·
  🔗 Agendar pelo site · 📍 Endereço e horários · 💬 Falar com atendente.
- Cliente com horário marcado recebe antes o card com Confirmar / Reagendar / Cancelar.
- "Falar com atendente": pausa a IA naquele chat por 1h, avisa o painel em tempo real
  (faixa verde no topo) e o gestor marca "Atendido" para a IA voltar.
- Sem botões/lista ativos, o menu sai em texto numerado e o cliente responde com o número.

## WuzAPI (terceiro motor de WhatsApp)

- `.env` do BarberSync: `WUZAPI_URL` e `WUZAPI_ADMIN_TOKEN` (o mesmo `WUZAPI_ADMIN_TOKEN` da WuzAPI).
- No `/superadmin`, escolha **Motor do WhatsApp: WuzAPI** na barbearia e o gestor clica em "Conectar WhatsApp".
- O BarberSync cria um usuário na WuzAPI por barbearia (nome = slug), guarda o token dele,
  configura o webhook (evento Message) e conecta. O QR aparece no painel como nos outros motores.
- Webhook: aceita `WEBHOOK_FORMAT=json` e o padrão `form` (campo `jsonData`).
- Áudio: usa o base64 que a WuzAPI já manda no webhook (sem `-skipmedia`); se faltar, baixa por `/chat/downloadaudio`.
- Enquete: na WuzAPI é sempre de escolha única (a IA pergunta se quer mais serviços depois).
- Botões e lista: mesmo formato interativo do Evolution GO (nó `biz`); teste no seu número.
