# Guia de plugins

[← README](README.md) · [Configuração](docs/CONFIGURATION.md) · [Segurança](SECURITY.md)

Plugins são módulos JavaScript locais que estendem a TUI e as ferramentas do agente.
Este guia descreve o loader implementado em `src/plugins.js`, não um plano futuro.

> Plugins executam código Node.js com os privilégios do usuário. A aprovação por
> hash e o campo `permissions` não fornecem sandbox. Revise o código antes de aprovar.

## Instalar o exemplo do cronômetro

A pasta efetiva de plugins é `<HOME da instância>/plugins/`. No modo compartilhado,
isso corresponde a `~/.kiro/plugins/`.

Para um teste previsível, copie o exemplo e execute explicitamente nesse modo:

```sh
# Na pasta clonada do kiro-code:
mkdir -p ~/.kiro/plugins
# Necessário para tratar .js como ESM nas versões de Node que exigem esse marcador.
# Se este arquivo já existir, preserve seu conteúdo e confira "type": "module".
test -f ~/.kiro/plugins/package.json || printf '{"type":"module"}\n' > ~/.kiro/plugins/package.json
cp examples/plugins/timer.js ~/.kiro/plugins/timer.js
KIRO_NO_ISOLATE=1 node bin/kiro.js
```

Dentro do Kiro:

```text
/plugins
/plugins approve timer
/timer
/timer stop
```

`/plugins approve` pode executar o plugin imediatamente. Não aprove sem revisar.
Para instalar um arquivo novo com o Kiro já aberto, rode `/plugins reload` antes
de aprová-lo, para que a descoberta seja refeita.

### Com isolamento por instância

`KIRO_INSTANCE=trabalho` usa uma pasta estável em `~/.kiro/instances/trabalho/`.
A descoberta lê o `plugins/` desse diretório lógico, não necessariamente o global.

Na criação de uma instância, o código tenta criar um symlink para a pasta global
**se ela já existir** e a pasta local ainda não existir. Uma pasta local já criada
não é substituída automaticamente. `/instances` ajuda a identificar o diretório.

Aprovação, configuração e dados também pertencem ao HOME lógico. Se mudar de
instância, não presuma que o estado do plugin foi sincronizado. Veja
[configuração e diretórios](docs/CONFIGURATION.md).

## Formatos

### Arquivo único

```text
plugins/
├── package.json       {"type":"module"}, quando necessário para ESM
└── hello.js
```

```js
export default {
  name: 'hello',
  version: '0.1.0',
  description: 'Meu primeiro plugin',
  setup(kiro) {
    kiro.command('/hello', {
      description: 'Mostra uma mensagem',
      run(args) {
        return `Olá, ${args.trim() || 'mundo'}!`;
      },
    });
  },
};
```

Em plugins de arquivo único, o nome usado pelo loader vem do **nome do arquivo**
(`hello.js` → `hello`). Não dependa de `default.name` para mudar o namespace.

### Pasta com manifesto

```text
agent-kit/
├── plugin.json
├── main.js
└── lib/
    ├── planner.js
    └── memory.js
```

```json
{
  "name": "agent-kit",
  "version": "0.1.0",
  "description": "Planejamento e memória local",
  "main": "main.js",
  "permissions": ["fs"],
  "config": {"maxPlans": 20}
}
```

`plugin.json` é o manifesto do loader, **não** um `package.json` do Node. Para
importar `.js` como ESM, mantenha `"type":"module"` em um `package.json` aplicável
à pasta do plugin. Imports relativos de submódulos usam o ESM nativo.

`permissions` é apenas uma declaração exibida na listagem. O loader não limita
imports de `node:fs`, `node:child_process` ou acesso à rede.

Exemplo incluído: [`examples/plugins/agent-kit`](examples/plugins/agent-kit/).
O `/plan` desse exemplo cria um registro de plano e o publica em um evento; não
é um planejador autônomo de IA. A ferramenta `listar_planos` do exemplo retorna
uma mensagem de limite configurado, não uma consulta completa dos registros.

## Contrato de execução

```js
let timer;
export default {
  async setup(kiro) {
    // Registre comandos, ferramentas, eventos e widgets.
    // Se criar recursos próprios, guarde como liberá-los.
  },
  async teardown() {
    clearInterval(timer);
  },
};
```

`setup(kiro)` é obrigatório e pode ser assíncrono. `teardown()` é opcional e é
chamado ao desativar ou recarregar. O loader remove os comandos, ferramentas,
widgets e assinaturas registrados pela API. Timers, subprocessos e outros
recursos criados diretamente pelo plugin precisam de limpeza própria.
Não existe um kill automático geral para JavaScript arbitrário.

O caminho de saída normal do aplicativo não faz uma rodada explícita de
`teardown` para todos os plugins antes de `process.exit`. Não dependa dele como
único mecanismo de persistência de dados importantes.

## API entregue ao `setup`

| API | Comportamento atual |
| --- | --- |
| `kiro.tool({schema, run})` | Registra ferramenta com nome `plug__<plugin>__<nome>` |
| `kiro.command(nome, {description, run})` | Registra comando slash; adiciona `/` se faltar |
| `kiro.widget(id, {render, interval?})` | Registra widget na faixa da TUI; `interval` (ms ≥ 250) controla o redesenho |
| `kiro.print(texto, cor?)` | Escreve no histórico da interface |
| `kiro.on(evento, fn)` | Assina evento; a assinatura é removida pelo loader na limpeza |
| `kiro.emit(evento, dados)` | Emite evento para os plugins carregados |
| `kiro.interval(fn, ms)` | `setInterval` seguro, **auto-limpado** no teardown/reload; devolve `cancel()` |
| `kiro.timeout(fn, ms)` | `setTimeout` seguro, **auto-limpado** no teardown/reload; devolve `cancel()` |
| `kiro.config` | Configuração efetiva do próprio plugin (defaults + salvo) |
| `kiro.configSet(chave, valor)` | Grava e persiste uma chave de config em `plugins.json` |
| `kiro.data.read(nome, fallback?)` | Lê JSON do `dataDir` do plugin |
| `kiro.data.write(nome, valor)` | Grava JSON no `dataDir` do plugin |
| `kiro.data.file(nome)` | Caminho absoluto de um arquivo no `dataDir` |
| `kiro.plugins()` | Lista `[{name, version, status}]` dos plugins carregados |
| `kiro.dataDir` | Diretório de dados do plugin no HOME lógico |
| `kiro.log(mensagem)` | Registra uma mensagem no debug.log local |

`command.run(args, ctx)` recebe o texto depois do comando e um **contexto**
`ctx = {cmd, args, owner, tui}`. O retorno pode ser:
- uma **string** → impressa no histórico;
- um **array de linhas** → cada item pode ser `"texto"` ou `[texto, cor]`.

Evite nomes que colidam com comandos internos ou de outros plugins: não há
isolamento robusto de colisões.

> **Timers:** `kiro.interval` e `kiro.timeout` são registrados e cancelados
> automaticamente na limpeza (desativar, reload). Prefira-os a `setInterval`
> global para não vazar recursos. Recursos criados diretamente (subprocessos,
> fontes de dados) continuam exigindo limpeza própria no `teardown`.


### Ferramentas

```js
kiro.tool({
  schema: {
    name: 'hora',
    description: 'Consulta a hora local',
    parameters: {type: 'object', properties: {}},
  },
  async run(args, ctx) {
    if (ctx.signal?.aborted) throw new Error('cancelado');
    const text = new Date().toISOString();
    return {
      text,
      ui: {subtitle: 'hora local', lines: [{t: 'o', s: text}]},
    };
  },
});
```

`ctx` pode conter `signal`, `vision` e `log`. Ferramentas de plugin precisam
cooperar com o cancelamento; um `AbortSignal` não interrompe uma função arbitrária
nem mata automaticamente subprocessos criados fora das ferramentas internas.

`text` volta para o modelo. `ui` descreve a caixa da ferramenta na interface.

### Eventos implementados

| Evento | Dados |
| --- | --- |
| `turn:start` | `{text}` |
| `turn:end` | `{seconds, usage}` |
| `tool:before` | `{name, args}` |
| `tool:after` | `{name, status, ms}` |
| `session:change` | `{id}` |
| Eventos próprios | Qualquer payload; use um prefixo como `plugin:meu-plugin:evento` |

`tool:after` **não entrega o resultado completo da ferramenta**. O barramento
chama listeners de forma síncrona, captura exceções síncronas e não aguarda
Promises retornadas; trate rejeições de operações assíncronas dentro do callback.
Eventos não são hooks canceláveis e não fornecem aprovação/bloqueio de ferramentas.

### Widgets

```js
kiro.widget('relogio', {
  render: () => [`Hora: ${new Date().toLocaleTimeString()}`],
  interval: 1000, // opcional: redesenho próprio (ms, mínimo 250)
});
```

- `render()` retorna um array de linhas.
- `interval` individual (ms, mínimo 250) define a cadência de redesenho do widget;
  sem ele, o widget é redesenhado a cada ~1 segundo.
- A faixa limita a saída a seis linhas no total, com indicação de excesso.
- Linhas vazias não ocupam a faixa; erros de render são ignorados no desenho,
  não convertem automaticamente o status do plugin em `erro`.

### Exemplo completo (timers, config e dados)

```js
export default {
  name: 'contador',
  version: '1.0.0',
  setup(kiro) {
    // contador persistente no dataDir
    const state = kiro.data.read('estado.json', { n: 0 });
    const meta = kiro.config.meta ?? 10;
    const cancel = kiro.interval(() => { state.n++; }, 1000); // auto-limpo no teardown

    kiro.widget('contador', {
      interval: 500,
      render: () => [`🔢 ${state.n} / meta ${meta}`],
    });

    kiro.command('/contador', {
      run(args, ctx) {
        if (args === 'salvar') { kiro.data.write('estado.json', state); return 'salvo'; }
        kiro.emit('plugin:contador:changed', { n: state.n });
        return [['Contador: ' + state.n, '\x1b[38;5;114m'], 'meta: ' + meta];
      },
    });
  },
  teardown() { /* timers via kiro.interval já são limpos; aqui só o que você criou */ },
};
```

## Aprovação, configuração e recarregamento

| Comando | Ação |
| --- | --- |
| `/plugins` ou `/plugins lista` | Lista estado, descrição, comandos e permissões declaradas |
| `/plugins approve nome` | Grava o hash aprovado e tenta ativar |
| `/plugins off nome` | Desativa e grava o estado |
| `/plugins on nome` | Ativa se o hash atual estiver aprovado; senão fica pendente |
| `/plugins reload` | Limpa instâncias atuais, refaz descoberta e recarrega |

O hash considera os arquivos descobertos do plugin. Após modificar arquivos,
refaça a descoberta com `/plugins reload` e revise/aprove o novo conteúdo. Não
edite um plugin aprovado durante seu carregamento esperando uma proteção de sandbox.

O entrypoint é importado com query de cache-busting. Submódulos ESM podem continuar
na cache do Node; reinicie o processo se alterações em helpers não aparecerem.

O arquivo `<HOME>/plugins.json` tem formato:

```json
{
  "approved": {},
  "disabled": [],
  "config": {"agent-kit": {"maxPlans": 50}}
}
```

Não invente hashes manualmente. Use o comando de aprovação. `kiro.config` faz um
merge superficial dos defaults do manifesto com `config[nome]`.

Plugins quebrados aparecem com status de erro sem impedir a descoberta dos demais.
Pastas com manifesto inválido aparecem como erro, não como instalação funcional.

## O que não está implementado

- Marketplace, instalação automática de URLs ou pacotes npm.
- Sandbox ou enforcement das permissões declaradas.
- API para substituir toda a TUI.
- Compilação automática de TypeScript.
- Kill garantido de processos/timers criados diretamente por código externo.
