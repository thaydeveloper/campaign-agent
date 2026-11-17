# SKU Mapping no Admin VTEX (demoindsupply)

App VTEX IO de Admin (`demoindsupply.sku-mapping`). Em **Catálogo → SKU Mapping**, o gestor escolhe uma organização B2B e importa a planilha `owner_sku → vtex_sku` dela. As regras do arquivo e o banco são os mesmos do SKU Mapping do `customer-portal-demoindsupply`: o que o gestor importa aparece no portal e no FastStore na hora.

A VTEX hospeda o app. Não há site nem URL pública.

## Estrutura

| Pasta | O que tem |
| --- | --- |
| `manifest.json` | Builders, políticas de acesso e as configurações do app (`settingsSchema`) |
| `admin/` | Menu (Catálogo → SKU Mapping) e as rotas `/admin/sku-mapping` e `/admin/sku-mapping/:organizationId` |
| `react/` | A tela. `skuMapping/mappingFile.ts` e `skuMapping/xlsx.ts` são as regras do arquivo e o leitor de XLSX portados do portal. O modelo em Excel está embutido em `skuMapping/template.ts` |
| `node/` | Serviço GraphQL: confere o token do Admin no VTEX ID, confere a organização na Master Data e chama o banco pela Data API do Supabase |
| `graphql/` | Schema das queries e mutations |
| `messages/` | Textos em inglês, português e espanhol |
| `db/` | Migração 005 e `writer-token.ts`, para copiar para o portal (que continua sendo a fonte do schema) |
| `test/` | Testes. As funções SQL rodam num Postgres real em memória (PGlite), com as migrações 001–004 do portal copiadas em `test/portal-migrations/` |

## Como funciona

```text
React no Admin ──GraphQL──▶ Node do app ──▶ VTEX ID   (o token é do Admin desta conta?)
                                        ──▶ Master Data CL, isCorporate=true   (a organização existe?)
                                        ──▶ Supabase Data API /rest/v1/rpc/sku_mapping_admin_*
```

- **Organização** é o contrato B2B: documento CL com `isCorporate=true`. O id dele é o `customerId`, gravado como `tenant_id`. Vai na URL, então o link pode ser compartilhado.
- **Importação:** soma. Códigos novos entram, os que já existem são atualizados e nada é apagado. O navegador lê e valida o arquivo, mostra erros e repetidos, e envia lotes de até 5.000 linhas com barra de progresso. Um lote que falha por rede é reenviado; reenviar um lote não muda nada.
- **Uma importação por vez por organização.** A trava é o índice da migração 001, então vale também para o portal. Uma importação parada há mais de 15 minutos é liberada, e quem a abriu pode cancelar.
- **Por que funções no banco:** um app VTEX IO só faz chamadas HTTP liberadas em `outbound-access` e não abre conexão com o Postgres. Pela Data API não dá para manter uma transação entre chamadas, então cada passo (`start`, `chunk`, `finish`, `cancel`, `overview`, `page`) é uma função que roda numa transação.

### Segurança

- Toda chamada exige o token do Admin (`adminUserAuthToken`), conferido em `POST /api/vtexid/credential/validate`: precisa ser `audience=admin` e da conta `demoindsupply`. O e-mail do gestor vira o `user_id` da importação.
- Antes de ler ou gravar, o Node confere na Master Data que a organização existe e é corporativa. Os lotes pulam essa ida: escrevem numa importação aberta para uma organização já conferida, e o banco só aceita lotes da mesma organização e do mesmo usuário.
- O papel `sku_mapping_writer` só executa as funções `sku_mapping_admin_*`. Não tem acesso a nenhuma tabela. A migração tira o `EXECUTE` de `PUBLIC`, `anon` e `authenticated`.
- O token do papel fica nas configurações do app e só o Node lê. O navegador nunca recebe credencial de banco.
- `outbound-access` libera só `vxmotxxwjhxdjnleqidr.supabase.co/rest/v1/rpc/*`, a validação do VTEX ID e `api.vtex.com/api/dataentities/CL/*`.

### Erros

O Node devolve o código como mensagem do erro GraphQL e a tela traduz:

| Código | Quando |
| --- | --- |
| `UNAUTHORIZED` | Token do Admin ausente, inválido ou de outra conta |
| `NOT_CONFIGURED` | Faltam as configurações do app |
| `ORGANIZATION_NOT_FOUND` | O id não é de um CL corporativo |
| `INVALID_INPUT`, `INVALID_ROWS` | Pedido ou lote fora das regras (o navegador já confere antes) |
| `IMPORT_RUNNING` | Já existe importação ativa na organização (Admin ou portal) |
| `IMPORT_NOT_RUNNING` | A importação foi encerrada, cancelada ou liberada |
| `UNAVAILABLE` | VTEX ID, Master Data, configurações ou banco não responderam. O detalhe vai para o log do app |

A conferência do arquivo (por exemplo `Row 3: owner_sku is required.`) continua em inglês, como no portal.

## Desenvolvimento

Requer Node 20+ e Yarn 1.

```bash
yarn setup       # instala node/, react/ e as ferramentas da raiz
yarn test        # 24 testes, sem banco externo
yarn typecheck   # Node, React (TypeScript 5.5 e o 3.9 do builder) e testes
```

## Colocar no ar

### 1. Levar o banco para o portal

No `customer-portal-demoindsupply`:

1. Copiar `db/migrations/005_sku_mapping_admin.sql` para `db/migrations/` e `db/writer-token.ts` para `db/`.
2. Em `package.json`, adicionar o script:
   ```json
   "db:writer-token": "node --env-file-if-exists=.env.local --import tsx db/writer-token.ts"
   ```
3. Em `tests/sku-mapping-schema.test.ts`, incluir `"005_sku_mapping_admin.sql"` na lista de migrações esperadas.
4. Em `.env.example`, documentar `# SKU_MAPPING_WRITER_JWT=` ao lado do `SKU_MAPPING_READER_JWT`.
5. Rodar:
   ```bash
   npm run db:migrate
   npm run db:writer-token   # grava SKU_MAPPING_WRITER_JWT no .env.local e testa na Data API
   ```

O `db:writer-token` usa o mesmo `SUPABASE_LEGACY_JWT_SECRET` do `db:reader-token`. Com `SUPABASE_PUBLISHABLE_KEY` definido, ele confirma que o token executa as funções e não lê a tabela. Para invalidar todos os tokens de escrita: `revoke sku_mapping_writer from authenticator;`.

### 2. Link num workspace de desenvolvimento

```bash
vtex login demoindsupply
vtex use dev
vtex link
```

Abrir `https://dev--demoindsupply.myvtex.com/admin/sku-mapping`.

### 3. Configurações do app

Em **Apps → SKU Mapping → Configurações** (no workspace em uso):

| Campo | Valor |
| --- | --- |
| Supabase URL | `https://vxmotxxwjhxdjnleqidr.supabase.co` |
| Supabase publishable key | Project Settings → API Keys → Publishable key |
| Writer token | O `SKU_MAPPING_WRITER_JWT` gerado no passo 1 |

Passe o token só por canal seguro, nunca em chat ou no repositório.

### 4. Produção

```bash
vtex publish
vtex use producao --production
vtex install demoindsupply.sku-mapping@0.x
vtex workspace promote
```

Preencha as configurações também no workspace de produção.

## Conferir no primeiro teste

- **Id da organização:** o plano assume que o id do CL corporativo é o `customerId` que o portal grava. Confirmar com uma organização que já tenha vínculos importados pelo portal: o total na tela tem que bater.
- **Resposta do VTEX ID:** o Node exige `authStatus=Success`, `audience=admin` e `account=demoindsupply` em `/api/vtexid/credential/validate`. Se a tela disser que a sessão não foi confirmada com um usuário logado, o log do app mostra o motivo.
- **Componentes da tela:** `Select` (com busca), `Dropzone`, `Progress`, `InputSearch` e `EmptyState` do `vtex.styleguide` só vão ser confirmados no link.
- **Navegação:** trocar de organização usa `navigate` do `vtex.render-runtime` com a rota `admin.app.sku-mapping.organization`. Confirmar que a URL do Admin muda para `/admin/sku-mapping/<customerId>`.
- **Trava compartilhada:** uma importação aberta por um comprador no portal bloqueia o Admin daquela organização até terminar, ou por no máximo 15 minutos.
