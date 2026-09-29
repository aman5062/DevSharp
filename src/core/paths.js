'use strict';
// Where DevSharp keeps its local files. Nothing here is ever uploaded.
//
//   Linux/macOS: $XDG_CONFIG_HOME/devsharp  (default ~/.config/devsharp)
//   Windows:     %APPDATA%\devsharp
//   Override:    $DEVSHARP_HOME

const os = require('os');
const path = require('path');

function homeDir(env = process.env) {
  if (env.DEVSHARP_HOME) return path.resolve(env.DEVSHARP_HOME);
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'devsharp');
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(base, 'devsharp');
}

function paths(env = process.env) {
  const home = homeDir(env);
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    packs: path.join(home, 'packs'),
    cache: path.join(home, 'cache'),
    projects: path.join(home, 'cache', 'projects.json'),
    updates: path.join(home, 'cache', 'updates.json'),
    sources: path.join(home, 'sources.json'),
    refreshLock: path.join(home, 'cache', 'refresh.lock'),
  };
}

const PKG_ROOT = path.resolve(__dirname, '..', '..');

module.exports = { homeDir, paths, PKG_ROOT };
