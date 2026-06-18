const config = require('./config');
const fs = require('fs');
const notify = require('./utils/notify');
const { logger } = require('./utils/logger');
const pkg = require('../package.json');

const BANNER = `
\x1b[38;5;105m╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ██╗███╗   ██╗ ██████╗ ██████╗ ██████╗ ██╗   ██╗████████╗  ║
║   ██║████╗  ██║██╔════╝██╔═══██╗██╔══██╗██║   ██║╚══██╔══╝  ║
║   ██║██╔██╗ ██║██║     ██║   ██║██████╔╝██║   ██║   ██║     ║
║   ██║██║╚██╗██║██║     ██║   ██║██╔══██╗██║   ██║   ██║     ║
║   ██║██║ ╚████║╚██████╗╚██████╔╝██║  ██║╚██████╔╝   ██║     ║
║   ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝   ╚═╝     ║
║                                                              ║
║\x1b[38;5;147m          ━━━ P H O T O   S Y N C ━━━                       \x1b[38;5;105m║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m`;

function printBanner() {
  console.log(BANNER);
  console.log('');
  logger.info(`\x1b[38;5;82m✔ Servidor iniciado correctamente\x1b[0m`);
  logger.info(`\x1b[38;5;75m  ├─ Puerto         :\x1b[0m ${config.PORT}`);
  logger.info(`\x1b[38;5;75m  ├─ Ruta SMB       :\x1b[0m ${config.TRABAJOS_BASE_PATH}`);
  logger.info(`\x1b[38;5;75m  ├─ Modo           :\x1b[0m ${config.IS_DEV_MODE ? '\x1b[33mDesarrollo\x1b[0m' : '\x1b[32mProducción\x1b[0m'}`);
  logger.info(`\x1b[38;5;75m  ├─ Mover a TERM.  :\x1b[0m ${config.ENABLE_FOLDER_MOVE ? '\x1b[32mActivado\x1b[0m' : '\x1b[33mDesactivado\x1b[0m'}`);
  logger.info(`\x1b[38;5;75m  ├─ Telegram       :\x1b[0m ${config.HAS_TELEGRAM ? '\x1b[32mConfigurado\x1b[0m' : '\x1b[33mNo configurado\x1b[0m'}`);
  logger.info(`\x1b[38;5;75m  ├─ Versión        :\x1b[0m v${pkg.version}`);
  logger.info(`\x1b[38;5;75m  └─ Dashboard      :\x1b[0m \x1b[4mhttp://localhost:${config.PORT}\x1b[0m`);
  console.log('');

  if (config.HAS_TELEGRAM) {
    const smbMounted = fs.existsSync(config.TRABAJOS_BASE_PATH);
    notify.notifyStartup(
      config.PORT,
      config.IS_DEV_MODE ? 'Desarrollo' : 'Producción',
      smbMounted
    ).catch(err => logger.error('Error al enviar notificación de inicio a Telegram:', err));
  }
}

module.exports = { printBanner };