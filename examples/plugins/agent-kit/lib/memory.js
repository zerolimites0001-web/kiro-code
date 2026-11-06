// Ouve os planos publicados pelo planner (outro módulo do mesmo plugin) e os guarda em dataDir.
import fs from 'node:fs';
import path from 'node:path';

export function createMemory(kiro) {
  const file = () => path.join(kiro.dataDir, 'planos.jsonl');

  return {
    register() {
      kiro.on('plugin:agent-kit:plan', (plan) => {
        fs.appendFileSync(file(), JSON.stringify(plan) + '\n');
        kiro.log(`plano ${plan.id} salvo`);
      });
    },
  };
}
