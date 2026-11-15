# Servidores MCP

[← README](../README.md) · [Segurança](../SECURITY.md)

O Kiro inclui um cliente MCP para importar **ferramentas** de servidores remotos.
A implementação usa JSON-RPC via **Streamable HTTP**, aceitando respostas JSON
ou SSE, com protocolo declarado `2025-06-18`.

Não é um cliente de todos os transportes e recursos possíveis do MCP.

## Configurar

Dentro do Kiro:

```text
/mcp
```

Use o assistente **ADD MCP** para informar nome, URL e autenticação. O endpoint
precisa começar com `http://` ou `https://`; para servidores remotos, prefira HTTPS.

Autenticações disponíveis no menu:

- Sem autenticação.
- Token em `Authorization: Bearer`.
- Header customizado, como `x-api-key`.
- `Mcp-Session-Id`, incluindo um Session ID extra quando necessário.

Não há fluxo OAuth completo no cliente. Um Session ID não é equivalente a uma
implementação genérica de login. Use o método efetivamente aceito pelo servidor.

Para remover/desconectar, use **REMOVE MCP**. Servidores habilitados são conectados
na inicialização. Uma conexão que falha pode ficar salva para nova tentativa pelo
assistente; confira a mensagem exibida, não apenas a presença do servidor na lista.

## Formato do arquivo

A configuração fica em `<HOME lógico>/mcp.json`. Com isolamento, normalmente é
`~/.kiro/instances/<id>/mcp.json`; com `KIRO_NO_ISOLATE=1`, `~/.kiro/mcp.json`.

```json
{
  "servers": {
    "meu-servidor": {
      "url": "https://seu-servidor.example/mcp",
      "auth": {"type": "none"},
      "enabled": true
    }
  }
}
```

A URL acima é ilustrativa. Configure um serviço que você realmente opere/conheça.
Tokens gravados no arquivo são texto legível, não um cofre criptografado.
Configurações MCP não são automaticamente propagadas a toda nova instância por PID;
use uma instância nomeada para reusar um diretório estável.

## Ferramentas no agente

Após inicializar a conexão, o cliente lista as ferramentas e as registra como:

```text
mcp__<nome-do-servidor>__<nome-da-ferramenta>
```

A descrição e o JSON Schema vêm do servidor. O modelo pode chamá-las pelo mesmo
registro usado pelas ferramentas locais. O cliente encaminha `tools/call` e
formata o retorno na TUI. Conteúdo textual é preservado; conteúdos não textuais
são representados de forma simplificada, não como suporte multimodal MCP completo.

## Limites atuais

- Sem transporte stdio ou implementação do antigo transporte HTTP+SSE separado.
- Sem interface genérica de resources/prompts MCP.
- Sem negociação OAuth completa.
- Timeout interno de chamadas não equivale a cancelamento remoto garantido.
- O AbortSignal do turno não é encaminhado a todas as chamadas MCP; interromper
  a TUI não garante que uma operação remota foi desfeita ou parada no servidor.
- Sem sandbox ou política de aprovação individual das ferramentas importadas.

Ferramentas remotas podem ter efeitos irreversíveis. Restrinja permissões/tokens
no próprio servidor, confira a conta usada e mantenha mecanismos externos de
controle quando houver acesso a produção, pagamentos ou dados sensíveis.
