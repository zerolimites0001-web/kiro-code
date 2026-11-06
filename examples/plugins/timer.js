// Exemplo de plugin de arquivo único: cronômetro ao vivo na TUI.
// Copie para ~/.kiro/plugins/timer.js e aprove com: /plugins approve timer
let start = null;

const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export default {
  name: 'timer',
  version: '0.1.0',
  description: 'Cronômetro ao vivo na faixa de widgets',

  setup(kiro) {
    kiro.widget('cronometro', {
      render: () => (start ? [`⏱  ${fmt(Date.now() - start)}   /timer stop para parar`] : []),
    });

    kiro.command('/timer', {
      description: 'Inicia ou para o cronômetro',
      run(args) {
        if (args.trim() === 'stop') {
          start = null;
          return 'Timer parado.';
        }
        start = Date.now();
        kiro.emit('plugin:timer:started', { at: start });
        return 'Timer iniciado.';
      },
    });
  },

  teardown() {
    start = null;
  },
};
