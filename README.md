# Kiro Code ✦

CLI leve de agente de código, em JavaScript puro (sem dependências), com TUI colorida no terminal.

## Instalação no Alpine Linux

```sh
apk add nodejs npm
cd kiro-code
npm link          # cria o comando "kiro" globalmente
kiro
```

Sem `npm link`, rode direto: `node bin/kiro.js`.

Requer Node.js 18+ (o `fetch` e o `ReadableStream` são nativos).

## Sessões e retry

**Sessões ficam em `~/.kiro/sessions/` e são compartilhadas entre abas.** Antes cada instância tinha a
sua cópia, e a mesma sessão acabava com versões diferentes (ex: 35 / 124 / 162 mensagens) — daí a
sensação de "metade do chat some". Agora:

- escrita **atômica** (`tmp` + `fsync` + `rename`) com `.bak` — nunca existe JSON pela metade no disco;
- **merge por prefixo**: se outra aba gravou um histórico maior nessa sessão, o disco ganha e a aba é avisada;
- arquivo corrompido **não some** da lista: aparece como `⚠ recuperável` e o `/resume` puxa o `.bak`;
- `/compact` guarda o histórico completo em `.pre-compact` antes de resumir;
- `/sessions` unifica cópias divergentes de instâncias antigas (fica sempre a maior).

**Apagar sessão (ctrl+d no `/resume`)** — a sessão ficava voltando porque o `healSessions()`, que roda a
cada start, varria as cópias em `~/.kiro/instances/pid-*/sessions/` (das abas antigas) e **recriava** a
sessão apagada. Agora:

- apagar grava um **tombstone** em `~/.kiro/deleted.json`;
- as cópias da sessão nas pastas de instâncias antigas são **removidas na hora**;
- o `healSessions()` **respeita o tombstone** e nunca ressuscita o que foi apagado (e limpa cópias que
  encontra); `listSessions()` também não lista sessão com tombstone.

**Retry**: toda chamada ao provedor (chat e listagem de modelos) tenta até **100 vezes**, com **3s** entre
tentativas. Erros permanentes (401/403/chave inválida/modelo inexistente) não são repetidos.
Ajuste com `KIRO_RETRY_TRIES` e `KIRO_RETRY_DELAY_MS`. Se a tentativa falhar no meio do stream, o texto
parcial é descartado antes da nova tentativa (sem texto duplicado).

## Comandos

| Comando     | Função                                              |
|-------------|-----------------------------------------------------|
| `/login`    | Adiciona provedor: OpenAI, Anthropic, Ollama ou custom (OpenAI/Anthropic-compatível) |
| `/provider` | Troca o provedor ativo                              |
| `/models`   | Lista e troca o modelo do provedor ativo            |
| `/resume`   | Retoma uma sessão salva (ctrl+r renomeia, ctrl+d apaga) |
| `/sessions` | Diagnóstico dos saves: mostra msg por sessão, lista corrompidas e unifica versões divergentes |
| `/new`      | Nova sessão                                         |
| `/clear`    | Limpa a tela                                        |
| `/help`     | Ajuda                                               |
| `/quit`     | Sai                                                 |

Atalhos: `↑/↓` histórico (no input) ou navegação (nos menus), `Enter` confirma, `Esc` cancela,
roda do mouse ou `PgUp/PgDn` rolam o histórico, `Ctrl+C` interrompe a resposta atual (2x sai).

## Interrupção (Ctrl+C / Esc)

`Ctrl+C` e `Esc` interrompem **qualquer** coisa em andamento — não só a resposta da IA:

- **stream da IA**: aborta a requisição na hora;
- **tool rodando** (`bash`, `loop`, ...): mata o processo **e toda a árvore dele** (um `bash` que
  subiu servidor/pipeline não deixa neto vivo), e a espera entre tentativas do `loop` para na hora;
- **entre passos do agente**: o loop não recria mais um turno novo depois do abort — antes o
  `AbortController` era recriado a cada passo e a IA "ressuscitava" e continuava rodando mesmo
  depois do Ctrl+C. Agora um flag `interrupting` encerra o turno de vez.

Se a interrupção pegar no meio de várias tool calls, os resultados ainda pendentes são
preenchidos com `ERRO: cancelado pelo usuário` — isso mantém o histórico válido (tool call sem
resposta fazia o provedor estourar no turno seguinte).

**Clique para expandir**: clicar em qualquer caixa de ferramenta (`bash`, `read_file`, `write_file`,
`edit_file`, `loop`) abre/fecha aquele bloco individualmente. Antes só o `Ctrl+O` funcionava e ele
afetava todos os blocos de uma vez. O rodapé de cada caixa mostra quantas linhas estão ocultas.
`Ctrl+O` continua valendo como expandir/recolher global.

## Testes

`node test_interrupt.mjs` verifica a interrupção real: abort de `bash`, kill da árvore de
processos (neto não escapa) e `loop` interrompível.

## Ferramentas do agente

- `bash`: executa comandos `sh` (funciona no busybox do Alpine)
- `read_file`: lê arquivo com intervalo de linhas
- `write_file`: cria ou sobrescreve arquivo
- `edit_file`: troca um trecho único (`old_string` → `new_string`)
- `loop`: repete um comando até dar certo (retries, esperar serviço, rodar testes até passar)

O agente roda em loop: chama ferramentas, recebe os resultados e continua até responder sem ferramentas (máx. 25 passos por mensagem).

## Prompt de sistema

O Kiro monta o system prompt com:

1. `~/.kiro/SYSTEM.md` (global)
2. `./SYSTEM.md` (do projeto)
3. `AGENTS.md` do diretório atual e dos pais, até a raiz

## Arquivos

- `~/.kiro/config.json`: provedores e modelo ativo (permissão 600, guarda API keys)
- `~/.kiro/sessions/*.json`: sessões salvas, retomáveis com `/resume`

## Estrutura

```
bin/kiro.js        entrada do comando "kiro"
src/app.js         agente, comandos, login, sessões
src/tui.js         renderização ANSI, teclado, mouse, menus
src/providers.js   streaming OpenAI-compatível e Anthropic
src/tools.js       bash, read_file, write_file, edit_file, loop
src/store.js       config, sessões e system prompt
```

## Google (Gemini) — provedor nativo

Use `/login` e escolha **Google (Gemini)**, depois cole a API key do Google AI Studio.
O provedor usa a API nativa do Gemini (`generativelanguage.googleapis.com/v1beta`), não o endpoint compatível com OpenAI.

- Contexto e saída máxima vêm de `inputTokenLimit` / `outputTokenLimit` da API; visão não é exposta pela API e é completada pelo models.dev.
- Thinking: Gemini 3 usa `thinkingLevel` (minimal → xhigh mapeia para high); Gemini 2.5 usa `thinkingBudget`. `/thinking off` deixa o padrão do modelo.
- Tokens de thinking (`thoughtsTokenCount`) entram no contador de saída, como no Anthropic.
- A `thoughtSignature` das tool calls é guardada no histórico e devolvida ao modelo (exigido pelo Gemini 3).
