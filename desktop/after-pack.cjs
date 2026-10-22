const fs = require('node:fs');
const path = require('node:path');

/**
 * Electron Builder puede excluir node_modules al copiar recursos adicionales.
 * El backend de ASISTIA corre con el runtime de Node empaquetado, por lo que
 * sus dependencias deben existir junto a backend/src/server.js.
 */
module.exports = async function afterPack(context) {
  const source = path.resolve(__dirname, '..', 'backend', 'node_modules');
  const destination = path.join(
    context.appOutDir,
    'resources',
    'backend',
    'node_modules'
  );

  if (!fs.existsSync(path.join(source, 'dotenv', 'package.json'))) {
    throw new Error('No se encontró dotenv en backend/node_modules antes del empaquetado.');
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true
  });

  if (!fs.existsSync(path.join(destination, 'dotenv', 'package.json'))) {
    throw new Error('No se pudieron copiar las dependencias del backend al paquete de escritorio.');
  }
};
