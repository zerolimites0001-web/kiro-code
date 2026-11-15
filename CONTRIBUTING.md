# Contribuindo com o Kiro Code

## Ambiente

- Node.js 18+; o projeto usa ESM e APIs nativas.
- Terminal ANSI interativo e `sh` para validação manual.
- Nenhuma dependência npm ou build obrigatório.

```sh
git clone https://github.com/zerolimites0001-web/kiro-code.git
cd kiro-code
npm run check
```

O check verifica sintaxe sem executar o aplicativo. A CI repete isso no Node 18,
22 e 24. Não representa teste funcional de TUI, shell, provedores ou plugins.

## Como propor uma alteração

1. Descreva o problema e o comportamento esperado na issue/PR.
2. Mantenha a proposta focada; evite mudar formatação e lógica de todo o projeto.
3. Preserve a ausência de dependências de runtime quando possível.
4. Atualize os guias junto com mudanças de API, comando, arquivo ou variável.
5. Informe o que foi realmente validado: sintaxe, testes locais e/ou chamada real.
6. Nunca envie chaves, sessões, logs sensíveis ou conteúdo de `~/.kiro/`.

## Validação manual

Se precisar executar o aplicativo, isole os dados do teste em outro HOME, por exemplo:

```sh
TEST_HOME=$(mktemp -d)
HOME="$TEST_HOME" KIRO_NO_ISOLATE=1 node bin/kiro.js
```

Esse procedimento separa os arquivos de configuração usuais, **não** isola shell,
rede, permissões ou o projeto. Revise o conteúdo e remova o diretório temporário
somente depois de conferir o que ele contém. Configure apenas credenciais de teste.

Quando relevante, valide:

- Entrada, colagem, rolagem, expansão de ferramentas e retomada de sessões.
- Cancelamento durante streaming, shell, espera de retry e entre ferramentas.
- Persistência após fechar/reabrir a mesma instância.
- Aprovação/recarregamento/desativação de plugin com dados descartáveis.
- Compatibilidade do formato de mensagens e tool calls com o backend alterado.

Não é necessário instalar Chromium ou ferramentas pesadas para contribuir.

## Pontos que exigem cuidado

- O tipo Google nativo ainda não é preservado corretamente no formato de configuração.
- Presets, metadados e limites não garantem disponibilidade na API real.
- Sessões compartilhadas usam heurísticas de reconciliação, não merge colaborativo.
- Protocolos MCP, cancelamento remoto e modalidades não têm cobertura completa.
- Plugins não são sandbox e recursos externos precisam de limpeza cooperativa.

Ao corrigir um desses pontos, inclua um caso reproduzível e não remova o aviso
correspondente da documentação antes de validar a correção.
