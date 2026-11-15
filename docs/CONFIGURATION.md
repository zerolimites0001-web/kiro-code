# Configuração, dados e contexto

[← README](../README.md) · [Provedores](PROVIDERS.md) · [Plugins](../PLUGINS.md)

## Diretório atual

Inicie o Kiro no diretório em que quer trabalhar. As ferramentas resolvem caminhos
relativos com `process.cwd()` e o shell herda o ambiente do processo.
Caminhos absolutos continuam acessíveis: isso não é isolamento de filesystem.

## Home global e home lógico

O diretório global é `~/.kiro/`, onde `~` é o home do usuário do sistema.
Por padrão, uma instância usa um HOME lógico dentro dele:

```text
~/.kiro/
├── SYSTEM.md                     Instruções globais opcionais
├── sessions/                     Sessões compartilhadas
├── deleted.json                  IDs de sessões excluídas
├── config.json                   Configuração global/legada herdada
├── models.json                   Provedores globais/legados; pode conter chaves
├── plugins/                      Fonte global opcional de plugins
└── instances/
    └── pid-<pid>/                Ou nome definido em KIRO_INSTANCE
        ├── instance.json
        ├── config.json           Provedor ativo e thinking
        ├── models.json           Provedores/modelos/chaves
        ├── models-dev.json       Cache do catálogo de metadados
        ├── mcp.json              Servidores e autenticação MCP
        ├── plugins.json          Aprovação, estado e config dos plugins
        ├── plugins/              Pasta efetiva ou symlink para a global
        ├── plugin-data/
        └── debug.log
```

O esquema mostra os locais usados pelo código, não arquivos obrigatoriamente
presentes em toda instalação. Sessões não ficam isoladas por PID no desenho atual.

`saveConfig()` também propaga provedores/configuração para os arquivos globais,
para adoção por novas instâncias. Isso não significa sincronização completa dos
arquivos MCP, plugins e preferências de todas as abas.

### Identidade estável

```sh
KIRO_INSTANCE=trabalho kiro
```

Reabrir com o mesmo nome reutiliza o diretório. Se o nome já estiver ocupado por
outro processo vivo, o código pode acrescentar um sufixo de PID.

### Desligar isolamento

```sh
KIRO_NO_ISOLATE=1 kiro
```

Nesse modo, o HOME lógico é o global `~/.kiro/`. É útil para uma configuração
compartilhada, mas todas as instâncias passam a usar os mesmos arquivos.

`/instances` exibe metadados locais e ajuda a identificar o diretório em uso.
Não é uma sessão remota ou um gerenciador de terminais.

## Credenciais

As chaves ficam em `models.json`; autenticação MCP pode ficar em `mcp.json`.
São arquivos JSON em texto, **não um cofre criptografado**. O código tenta criar
vários arquivos sensíveis com modo `0600`, mas permissões dependem do filesystem,
de cópias e do ambiente. Backups também podem conter segredos.

Não envie esses arquivos, a pasta `~/.kiro/`, sessões ou logs a repositórios públicos.
O agente, plugins e comandos executados com seu usuário podem ter acesso a eles.

## Sessões e recuperação

- Sessões compartilhadas em `~/.kiro/sessions/`, salvo override por ambiente.
- Escrita temporária, fsync e rename reduzem o risco de JSON parcial.
- `.bak` serve como fallback quando há JSON inválido.
- `/sessions` diagnostica e tenta unificar históricos de instâncias antigas.
- Exclusão registra um tombstone para evitar restauração acidental por cópias antigas.
- Compactação cria backups como `.pre-compact` ou `.auto-compact` antes de resumir.

Merge/recuperação usam heurísticas de histórico e tamanho, não resolução semântica
de conflitos. Duas abas editando a mesma sessão podem divergir. Backups locais
não substituem uma cópia externa que você controle.

## Instruções do projeto

O prompt inclui o prompt interno do agente e pode agregar:

1. `~/.kiro/SYSTEM.md`, global.
2. `SYSTEM.md` no diretório atual.
3. `AGENTS.md` no diretório atual e nos pais, coletados até a raiz.

O repositório não precisa distribuir um `SYSTEM.md` para funcionar. Não coloque
chaves ou segredos nesses arquivos: seu conteúdo pode ir para o modelo.
Instruções são contexto para a IA, não um mecanismo de autorização de comandos.

## Variáveis de ambiente

| Variável | Default | Efeito |
| --- | --- | --- |
| `KIRO_INSTANCE` | `pid-<pid>` | Nome do diretório lógico da instância |
| `KIRO_NO_ISOLATE` | Ausente | Valor `1` usa `~/.kiro/` diretamente |
| `KIRO_SESSIONS_DIR` | `~/.kiro/sessions/` | Diretório alternativo de sessões |
| `KIRO_RETRY_TRIES` | `100` | Máximo padrão de tentativas da política de retry |
| `KIRO_RETRY_DELAY_MS` | `3000` | Pausa padrão entre tentativas |
| `KIRO_MAX_OUT` | `60000` | Limite aproximado de caracteres de saída devolvidos por ferramentas; mínimo 1000 |

Exemplo com tentativas mais curtas:

```sh
KIRO_INSTANCE=trabalho KIRO_RETRY_TRIES=5 KIRO_RETRY_DELAY_MS=1000 kiro
```

O limite de saída preserva começo e fim e pode truncar o meio. A TUI também limita
linhas guardadas para expansão; não suponha que toda saída longa permaneceu visível.

## Custo e contexto

`/compact` chama o modelo e pode gerar cobrança. A compactação automática tenta
agir quando o uso informado/estimado chega a 85% da janela configurada, com histórico
suficiente. Um resumo pode omitir informação relevante; consulte o backup quando
necessário. O agente pode fazer muitas chamadas consecutivas: acompanhe o consumo.
