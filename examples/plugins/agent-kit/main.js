// Arquivo de entrada do plugin de pasta. Importa módulos internos com ./lib/...
import { createPlanner } from './lib/planner.js';
import { createMemory } from './lib/memory.js';

export default {
  name: 'agent-kit',
  version: '0.1.0',

  setup(kiro) {
    const memory = createMemory(kiro);
    const planner = createPlanner(kiro, memory);

    planner.register();
    memory.register();
  },
};
