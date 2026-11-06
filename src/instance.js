import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Isolamento de instância do Kiro Code.
 *
 * Problema: dois `kiro` abertos em abas diferentes do mesmo terminal escrevem
 * no MESMO `~/.kiro/` — config.json, models.json e as sessões. Um `/login` numa
 * aba reaparece na outra, sessões de um lado aparecem do outro, e os arquivos
 * de sessão se sobrescrevem no meio do turno (daí "as tool call se misturam").
 *
 * Solução: cada processo ganha um ID estável e um diretório próprio:
 *
 *   KIRO_INSTANCE definido (ex: export KIRO_INSTANCE=aba1)  -> usa esse nome
 *   senão                                                    -> usa o PID
 *
 * O diretório de trabalho fica `~/.kiro/instances/<id>/` com um `HOME` lógico
 * por instância (config.json, models.json, sessions/, plugins/, plugin-data/).
 * Se já existe uma instância com o MESMO PID (raro, PID reutilizado), rotaciona.
 *
 * O primeiro a subir pode "adotar" os dados legados de `~/.kiro/` para não
 * perder login/sessões antigos — feito uma única vez e marcado com um flag.
 * Para desativar tudo: KIRO_NO_ISOLATE=1.
 */

export const GLOBAL_HOME = path.join(os.homedir(), '.kiro');
const INSTANCES = path.join(GLOBAL_HOME, 'instances');

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

function ensureDir(d) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
  return d;
}

function writeIfMissing(file, content) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { mode: 0o600 });
  } catch {}
}

function copyIfMissing(from, to) {
  try {
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Adoção dos dados legados (do ~/.kiro antigo, de antes do isolamento).
 * É POR INSTÂNCIA e idempotente: cada aba nova herda config/models/plugins e o
 * histórico de sessões antigo, mas só o que ela ainda não tem. Assim a 2ª aba
 * também loga no provedor já configurado, sem sobrescrever o que ela criar.
 */
function adoptLegacy(home) {
  let copied = 0;
  if (copyIfMissing(path.join(GLOBAL_HOME, 'config.json'), path.join(home, 'config.json'))) copied++;
  if (copyIfMissing(path.join(GLOBAL_HOME, 'models.json'), path.join(home, 'models.json'))) copied++;
  if (copyIfMissing(path.join(GLOBAL_HOME, 'plugins.json'), path.join(home, 'plugins.json'))) copied++;
  if (copyIfMissing(path.join(GLOBAL_HOME, 'mcp.json'), path.join(home, 'mcp.json'))) copied++;

  // Sessões NÃO são copiadas por instância (era a causa do histórico divergente:
  // cada aba seguia escrevendo na sua cópia congelada e "metade do chat sumia").
  // Todas as abas leem e escrevem em ~/.kiro/sessions — ver store.js.

  // Plugins: symlink da pasta global (se existir) pra não duplicar código.
  const fromPlugins = path.join(GLOBAL_HOME, 'plugins');
  const toPlugins = path.join(home, 'plugins');
  try {
    if (fs.existsSync(fromPlugins) && !fs.existsSync(toPlugins)) {
      fs.symlinkSync(fromPlugins, toPlugins, 'dir');
    }
  } catch {}
  return copied;
}

let resolved = null;

/** Resolve (uma única vez) o HOME lógico desta instância. */
export function resolveInstance() {
  if (resolved) return resolved;

  if (process.env.KIRO_NO_ISOLATE === '1') {
    resolved = { id: 'shared', home: GLOBAL_HOME, isolated: false, dir: GLOBAL_HOME };
    return resolved;
  }

  ensureDir(INSTANCES);

  let id = (process.env.KIRO_INSTANCE || '').trim();
  let dir;
  let token = null;

  if (id) {
    dir = path.join(INSTANCES, id);
    ensureDir(dir);
    // Se outra instância VIVA já usa esse nome, avisa (mas mantém — é escolha
    // explícita do usuário) rotacionando só o token interno de segurança.
    const lock = path.join(dir, 'instance.json');
    try {
      const prev = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) id = `${id}-${process.pid}`;
    } catch {}
    dir = path.join(INSTANCES, id);
    ensureDir(dir);
  } else {
    id = `pid-${process.pid}`;
    dir = path.join(INSTANCES, id);
    // Colisão rara (PID reciclado): rotaciona o token.
    try {
      if (fs.existsSync(path.join(dir, 'instance.json'))) {
        const prev = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
        if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
          token = crypto.randomBytes(3).toString('hex');
          id = `pid-${process.pid}-${token}`;
          dir = path.join(INSTANCES, id);
          ensureDir(dir);
        }
      }
    } catch {}
  }

  const home = dir;

  // Adoção dos dados legados, POR INSTÂNCIA (idempotente). Cada aba nova herda
  // o config/models/plugins do ~/.kiro antigo e o histórico de sessões, sem
  // pisar no que outra aba já criou.
  const n = adoptLegacy(home);

  const meta = { id, pid: process.pid, cwd: process.cwd(), token, adopted: n, startedAt: new Date().toISOString(), home };
  try {
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(meta, null, 2));
  } catch {}

  resolved = { id, home, isolated: true, dir };
  return resolved;
}

/** IDs de instâncias registradas (para `/instances`). */
export function listInstances() {
  const out = [];
  try {
    if (!fs.existsSync(INSTANCES)) return out;
    for (const id of fs.readdirSync(INSTANCES)) {
      const f = path.join(INSTANCES, id, 'instance.json');
      if (!fs.existsSync(f)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        m.alive = m.pid ? pidAlive(m.pid) : false;
        out.push(m);
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Remove instâncias mortas antigas (com PID que não existe mais). */
export function pruneInstances(keep = 20) {
  const all = listInstances();
  const dead = all.filter((m) => !m.alive);
  for (const m of dead.slice(0, Math.max(0, dead.length - keep))) {
    try {
      fs.rmSync(path.join(INSTANCES, m.id), { recursive: true, force: true });
    } catch {}
  }
  return dead.length;
}

/** Caminho dos dados persistentes que NÃO são por-instância (compartilhados). */
export const shared = { GLOBAL_HOME };
