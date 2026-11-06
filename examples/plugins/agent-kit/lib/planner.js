// /plan <texto>: cria um plano, grava em dataDir e publica o evento para outros módulos.
export function createPlanner(kiro) {
  return {
    register() {
      kiro.command('/plan', {
        description: 'Cria um plano de passos a partir do texto',
        run(text) {
          if (!text.trim()) return 'Uso: /plan <objetivo>';
          const plan = { id: Date.now(), goal: text.trim(), steps: [] };
          kiro.emit('plugin:agent-kit:plan', plan);
          return `Plano criado: ${plan.goal}`;
        },
      });

      kiro.tool({
        schema: {
          name: 'listar_planos',
          description: 'Lista os planos salvos pelo plugin agent-kit',
          parameters: { type: 'object', properties: {} },
        },
        async run() {
          const text = kiro.config.maxPlans ? `Limite de ${kiro.config.maxPlans} planos` : 'sem limite';
          return { text, ui: { subtitle: text, lines: [] } };
        },
      });
    },
  };
}
