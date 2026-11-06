# Plano de plugins do Kiro Code

## 1. Objetivo

Permitir estender o Kiro sem mexer no código-fonte. Um plugin pode:

- registrar ferramentas para o agente (`bash`, `read_file`, ...)
- registrar comandos slash (`/timer`, `/deploy`, ...)
- mostrar **widgets ao vivo** na TUI (ex: um timer rodando)
- reagir a eventos do agente (início/fim de turno, antes/depois de cada ferramenta)
- conversar com outros plugins por eventos

Plugins ficam em `~/.kiro/plugins/` e são carregados na inicialização.

## 2. Formas de plugin

### 2.1 Arquivo único

```
~/.kiro/plugins/timer.js
```

Um arquivo ES module com export default. Ideal para coisas pequenas.

### 2.2 Pasta com manifesto

```
~/.kiro/plugins/agent-kit/
├── plugin.json        manifesto (obrigatório)
├── main.js            arquivo de início (indicado em "main")
├── lib/
│   ├── planner.js     módulos internos, importados com ./lib/...
│   └── memory.js
└── assets/            opcional
```

`plugin.json`:

```json
{
  "name": "agent-kit",
  "version": "0.1.0",
  "description": "Kit de planejamento e memória para o agente",
  "main": "main.js",
  "permissions": ["shell", "fs"],
  "config": {
    "maxSteps": 10
  }
}
```

- `main` é o arquivo de entrada. Os demais arquivos são importados livremente pelo `main.js` (ESM nativo, sem bundler).
- `permissions` é informativo nesta versão: o Kiro mostra no `/plugins` o que cada plugin declara.
- `config` são valores padrão que o usuário pode sobrescrever em `~/.kiro/plugins.json`.
- Plugins de pasta podem se conectar entre si via o barramento de eventos (seção 5).

## 3. Contrato do plugin

Todo plugin exporta um objeto com `setup(kiro)`:

```js
export default {
  name: 'timer',
  version: '0.1.0',
  setup(kiro) {
    kiro.command('/timer', {
      description: 'Inicia um timer e mostra na TUI',
      async run(args) { /* ... */ },
    });
  },
  teardown() { /* opcional: limpar intervalos, fechar conexões */ },
};
```

`setup` pode ser assíncrono. `teardown` é chamado ao recarregar ou desativar o plugin.

## 4. API `kiro` entregue ao plugin

| Método | Para que serve |
|---|---|
| `kiro.tool({ schema, run })` | Registra uma ferramenta que o modelo pode chamar. Mesmo formato das ferramentas internas. |
| `kiro.command(name, { description, run })` | Registra um comando `/nome`. `run(args, ctx)` recebe o texto depois do comando. |
| `kiro.widget(id, { render, interval })` | Cria uma área ao vivo na TUI (ver seção 6). `render()` devolve linhas; o Kiro redesenha a cada `interval` ms. |
| `kiro.print(texto, cor?)` | Escreve no histórico, como as mensagens do sistema. |
| `kiro.on(evento, fn)` | Assina um evento do agente (seção 5). |
| `kiro.emit(evento, dados)` | Publica um evento para outros plugins. |
| `kiro.config` | Configuração efetiva (padrões do `plugin.json` + ajustes do usuário). |
| `kiro.dataDir` | Pasta própria do plugin para guardar dados: `~/.kiro/plugin-data/<name>/`. |
| `kiro.log(msg)` | Grava em `~/.kiro/debug.log`, marcado com o nome do plugin. |

Nada de API de rede ou shell é exposto por padrão. Quem precisa de shell usa `child_process` diretamente, e isso fica registrado como permissão declarada.

## 5. Eventos

Eventos previstos:

| Evento | Quando | Dados |
|---|---|---|
| `turn:start` | Usuário envia mensagem | `{ text }` |
| `turn:end` | Agente termina o turno | `{ seconds, usage }` |
| `tool:before` | Antes de executar uma ferramenta | `{ name, args }` |
| `tool:after` | Depois | `{ name, status, result }` |
| `session:change` | Trocou de sessão (`/new`, `/resume`) | `{ id }` |
| `plugin:*` | Eventos próprios de plugins | livre |

Conexão entre plugins: o `agent-kit` emite `plugin:agent-kit:plan`, e outro plugin que quiser ouvir faz `kiro.on('plugin:agent-kit:plan', fn)`. Nada é acoplado por import.

## 6. Widgets ao vivo (o timer)

A TUI ganha uma **faixa de widgets** entre o histórico e a linha separadora. Cada widget ocupa de 1 a N linhas e é redesenhado no intervalo declarado.

Exemplo do `timer.js`:

```js
let start = null;
let interval = null;

export default {
  name: 'timer',
  version: '0.1.0',
  setup(kiro) {
    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };

    kiro.widget('timer', {
      interval: 1000,
      render: () => (start ? [`⏱  ${fmt(Date.now() - start)}   (/timer stop para parar)`] : []),
    });

    kiro.command('/timer', {
      description: 'Inicia ou para um cronômetro na TUI',
      run(args) {
        if (args.trim() === 'stop') {
          start = null;
          return kiro.print('Timer parado.');
        }
        start = Date.now();
        kiro.print('Timer iniciado.');
      },
    });
  },
};
```

Regras da faixa de widgets:

- Só widgets com conteúdo (`render()` com linhas) ocupam espaço. Sem conteúdo, a área some.
- Limite de 6 linhas no total. Acima disso o Kiro corta e mostra `… +N`.
- O redesenho do widget é só da faixa, não do histórico, para não piscar.
- Um widget que lança erro é desativado e aparece no `/plugins` como `erro`.

## 7. Carregamento e ciclo de vida

Na inicialização:

1. Lê `~/.kiro/plugins.json` (lista de desativados e sobrescrita de config).
2. Varre `~/.kiro/plugins/`:
   - `*.js` → plugin de arquivo único
   - pasta com `plugin.json` → lê `main` e importa
   - pasta sem `plugin.json` → ignorada, com aviso no `/plugins`
3. Importa cada um com `import()` dentro de `try/catch`. Um plugin quebrado não derruba os outros.
4. Chama `setup(kiro)`.

Comandos:

| Comando | Faz |
|---|---|
| `/plugins` | Lista: nome, versão, status (ativo, desativado, erro), comandos, widgets, permissões |
| `/plugins reload` | Chama `teardown` de todos, reimporta com `?v=timestamp` e chama `setup` de novo |
| `/plugins off <nome>` | Desativa e grava em `plugins.json` |
| `/plugins on <nome>` | Reativa |

Ao recarregar, os comandos e ferramentas de plugin são removidos antes e registrados de novo, para não duplicar.

## 8. Mudanças necessárias no código atual

| Arquivo | Mudança |
|---|---|
| `src/tools.js` | `TOOLS` vira um registro dinâmico: `registerTool()` e `unregisterTool()`. As internas continuam fixas. |
| `src/app.js` | Substitui o `switch` de comandos por um registro: internos + plugins. Chama `emit` nos eventos do turno e das ferramentas. |
| `src/tui.js` | Nova faixa de widgets acima do separador. Redesenho só dela com timer. Limite de linhas. |
| `src/plugins.js` (novo) | Loader, API `kiro`, barramento de eventos, `/plugins`. |
| `bin/kiro.js` | Nada. |

## 9. Segurança

Plugins rodam com os mesmos privilégios do usuário. Isso precisa ser dito na documentação e no `/plugins`. Plano:

- Só carregar de `~/.kiro/plugins/`. Nada de URL nem auto-instalação.
- Mostrar a lista de permissões declaradas na primeira vez que um plugin carrega, e pedir confirmação. Guardar a aprovação em `plugins.json` com o hash do arquivo. Se o arquivo mudar, pede de novo.
- Plugins não recebem o `config.json` nem a `apiKey` dos provedores. Só o próprio `kiro.config`.

## 10. Ordem de implementação

1. **Loader e API mínima**: `plugins.js`, `kiro.command`, `kiro.print`, `kiro.log`, `/plugins`. Teste com um `hello.js`.
2. **Ferramentas de plugin**: `kiro.tool` e registro dinâmico em `tools.js`. Teste com uma ferramenta `relogio`.
3. **Eventos**: `kiro.on` e `kiro.emit` nos pontos do `app.js`. Teste com um plugin que conta turnos.
4. **Faixa de widgets na TUI** e o `timer.js` como exemplo de referência.
5. **Plugins em pasta**: `plugin.json`, `main`, imports relativos. Exemplo `agent-kit/` com dois arquivos que se conectam por evento.
6. **Permissões e aprovação** por hash.
7. **Recarregar sem reiniciar** (`/plugins reload`).

Cada etapa é testável sozinha e não quebra o que já existe.

## 11. Fora do escopo desta versão

- Instalar plugin de URL ou de um registro (npm, marketplace).
- Sandbox de execução. Plugins são confiáveis pelo usuário.
- Plugins escritos em TypeScript sem compilar. Precisa ser JavaScript ESM.
- Plugins que substituem a TUI inteira.
