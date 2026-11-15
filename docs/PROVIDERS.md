# Provedores e modelos

[← README](../README.md) · [Configuração](CONFIGURATION.md)

## O que o cliente implementa

| Caminho | Implementação |
| --- | --- |
| OpenAI-compatível | Chat com streaming SSE e ferramentas |
| Anthropic | Messages com streaming e ferramentas |
| Google | Gemini nativo, conversão de mensagens, imagens e chamadas de função; experimental |

Os presets NVIDIA NIM, Arena e Ollama usam o adaptador OpenAI-compatível.
Compatibilidade depende do endpoint e dos campos suportados pelo serviço, não
apenas do nome do provedor. O projeto não garante acesso a qualquer modelo pago.

## Configurar pelo terminal

1. `/login`: escolha um preset ou Custom.
2. Informe chave/base URL conforme o serviço.
3. Aguarde a sincronização/lista e escolha um modelo disponível.
4. `/provider`: troque de serviço.
5. `/models`: selecione o modelo padrão do serviço ativo.
6. `/mod-provider`: edite endpoint, modelos e metadados.

No Ollama, inicie o servidor e disponibilize o modelo antes de usá-lo. O preset
permite chave vazia. O Kiro não baixa pesos, não instala o Ollama e não inicia o
servidor de inferência por você.

A lista da Anthropic começa com IDs definidos no código. Outras APIs podem expor
listagem dinâmica. Um ID sugerido no preset não garante existência/disponibilidade;
use a documentação do provedor e ajuste o modelo quando necessário.

## Google: limitação conhecida importante

`src/providers.js` contém o adaptador nativo Google, com listagem de modelos,
streaming, function calls e thought signatures. Entretanto, `saveConfig()` em
`src/store.js` grava apenas a distinção Anthropic/OpenAI no formato persistido.
`loadConfig()` não restaura o tipo Google e o interpreta como OpenAI.

Consequência: após reiniciar, um provedor Google pode usar a rota de API errada.
Também há presets de IDs cuja disponibilidade não foi validada. **Considere esse
suporte experimental**, não uma integração estável garantida pela presença no menu.
Essa documentação não altera o adaptador nem mascara a limitação.

## Thinking, visão e limites

Níveis de thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
Use `/thinking` ou Shift+Tab. A tradução desses níveis varia por adaptador; alguns
modelos não reconhecem certos níveis ou não retornam pensamentos separados.

`read_image` exige suporte/metadata de visão e envia dados da imagem ao backend.
Não basta que o terminal consiga mostrar o nome do arquivo.

Metadados de contexto, saída, reasoning e modalidades usam valores salvos por
modelo, informações do endpoint e um catálogo `https://models.dev/api.json`.
O cache fica no HOME da instância e é considerado recente por 24 horas. Sem rede,
o cliente tenta a cópia existente e depois usa os padrões do código.

Os padrões incluem 128000 tokens de contexto e 16384 de saída, mas são estimativas
de fallback, não promessas do serviço. O host Arena possui overrides específicos
(1M de contexto, 131k de saída e entrada de imagem), ajustáveis por campos manuais.
Esses valores não ampliam limites reais da API ou da conta.

## Retry

A política padrão usa até 100 tentativas, com espera de 3 segundos entre falhas
transitórias. É uma espera fixa, não backoff exponencial. Falhas permanentes como
401/403 e determinados erros de requisição/modelo não devem ser repetidos.

```sh
KIRO_RETRY_TRIES=5 KIRO_RETRY_DELAY_MS=1000 kiro
```

Esses defaults podem ser sobrescritos no fluxo que chama a política. Nem toda
requisição de rede do aplicativo usa o mesmo wrapper; por exemplo, catálogo e
MCP possuem caminhos próprios. Retries podem aumentar tempo e consumo do backend.
Interrompa com Esc/Ctrl+C quando necessário.

## Rede e dados enviados

Provedores recebem as mensagens e os resultados de ferramentas que entram no
contexto, podendo incluir código, caminhos, imagens e saída de shell. Autenticação
é enviada ao endpoint configurado. Revise URLs de serviços customizados antes
de fornecer uma chave e não use HTTP aberto para credenciais remotas.

O catálogo de modelos é uma requisição externa adicional. Usar inferência local
não garante que nenhuma conexão externa será feita pelo aplicativo ou por plugins.
