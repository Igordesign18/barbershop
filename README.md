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
