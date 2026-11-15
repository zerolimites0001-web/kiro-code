# Segurança e privacidade

Kiro Code é uma ferramenta de desenvolvimento com execução local. **Não é uma
sandbox** nem uma fronteira de segurança contra modelos, prompts ou plugins maliciosos.

## Antes de iniciar

- Trabalhe com Git e um backup que o agente não possa apagar facilmente.
- Use um usuário com o mínimo de privilégios necessário; evite executar como root.
- Não disponibilize ao processo tokens de produção, agentes SSH ou credenciais
  de cloud que não sejam necessários à tarefa.
- Revise comandos, diffs e resultados. Uma resposta convincente pode estar errada.
- Para tarefas não confiáveis, considere um ambiente separado e com credenciais
  restritas; um container mal configurado também não oferece isolamento completo.

## Ferramentas locais

O modelo pode acionar shell e escrita/edição de arquivos. O código atual não exige
confirmação humana para cada ação, não confina caminhos ao diretório do projeto
e não impõe uma allowlist de comandos.

O shell herda o ambiente do processo. Assim, um comando pode acessar variáveis,
arquivos do usuário, rede e serviços disponíveis. Instruções em SYSTEM.md/AGENTS.md
orientam o modelo, mas não substituem uma política de autorização.

Interrupções tentam abortar o turno e encerrar processos de shell em grupos POSIX.
Não são rollback: comandos já concluídos, efeitos remotos e processos que escapam
do grupo podem continuar tendo consequências.

## Dados enviados e salvos

Código, trechos de arquivos, resultados de ferramentas e imagens podem entrar no
contexto enviado ao provedor escolhido. Leia os termos e a política do serviço.
A consulta de metadados a models.dev é uma conexão de rede adicional.

Chaves de API e autenticação MCP podem ser salvas em JSON no HOME lógico e em
cópias globais/backups. Permissão de arquivo não é criptografia. Sessões e logs
podem conter informação sensível; não os publique sem revisão.

## Plugins

Plugins têm acesso ao Node.js e aos mesmos recursos do usuário do processo.
`permissions` no manifesto é informativo, sem enforcement. Aprovação por hash
serve para autorizar uma versão descoberta do código, não para restringi-la.

A API não recebe o objeto completo de provedores, mas isso **não impede** que um
plugin leia arquivos de configuração diretamente. Código de plugin pode executar
shell, abrir rede ou sobrescrever comandos, inclusive fora das APIs documentadas.

A limpeza remove recursos registrados pelo loader. Timers, processos e alterações
arbitrárias precisam de teardown próprio, que também não é garantia contra código
não cooperativo. Não aprove um plugin desconhecido apenas por ele pedir poucas
permissões declaradas.

## MCP

Servidores MCP podem expor operações de escrita, deploy ou administração. Restrinja
credenciais no servidor e use HTTPS fora de ambientes locais controlados.
Interromper uma chamada do lado do cliente não garante cancelamento da ação remota.

## Relatar problemas

Abra uma issue com impacto e passos de reprodução que **não contenham tokens,
chaves, dados pessoais ou acesso a sistemas reais**. Para demonstrações, use
credenciais falsas e um projeto isolado. Não publique detalhes sensíveis em logs
ou capturas. Se uma credencial já foi exposta, revogue-a no serviço de origem;
apagar a mensagem ou o commit não basta.

Este documento descreve limitações conhecidas, não uma certificação de segurança.
