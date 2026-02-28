import * as os from 'os';
import * as path from 'path';

const USER_CONFIG_DIR_NAME = 'res';
const CUSTOM_FETCHERS_DIR = 'fetchers';

export function resolveUserConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, USER_CONFIG_DIR_NAME);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, USER_CONFIG_DIR_NAME);
    }
  }
  return path.join(os.homedir(), '.config', USER_CONFIG_DIR_NAME);
}

export function resolveCustomFetchersDirectory(): string {
  return path.join(resolveUserConfigDir(), CUSTOM_FETCHERS_DIR);
}