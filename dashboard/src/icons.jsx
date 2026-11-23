import add from '@material-symbols/svg-400/outlined/add.svg?raw';
import arrow_drop_down from '@material-symbols/svg-400/outlined/arrow_drop_down.svg?raw';
import block from '@material-symbols/svg-400/outlined/block.svg?raw';
import bolt from '@material-symbols/svg-400/outlined/bolt.svg?raw';
import check from '@material-symbols/svg-400/outlined/check.svg?raw';
import close from '@material-symbols/svg-400/outlined/close.svg?raw';
import content_copy from '@material-symbols/svg-400/outlined/content_copy.svg?raw';
import dashboard from '@material-symbols/svg-400/outlined/dashboard.svg?raw';
import delete_ from '@material-symbols/svg-400/outlined/delete.svg?raw';
import download from '@material-symbols/svg-400/outlined/download.svg?raw';
import edit from '@material-symbols/svg-400/outlined/edit.svg?raw';
import history from '@material-symbols/svg-400/outlined/history.svg?raw';
import logout from '@material-symbols/svg-400/outlined/logout.svg?raw';
import key from '@material-symbols/svg-400/outlined/key.svg?raw';
import layers from '@material-symbols/svg-400/outlined/layers.svg?raw';
import lock from '@material-symbols/svg-400/outlined/lock.svg?raw';
import lock_open from '@material-symbols/svg-400/outlined/lock_open.svg?raw';
import person from '@material-symbols/svg-400/outlined/person.svg?raw';
import power_settings_new from '@material-symbols/svg-400/outlined/power_settings_new.svg?raw';
import search from '@material-symbols/svg-400/outlined/search.svg?raw';
import shield from '@material-symbols/svg-400/outlined/shield.svg?raw';
import shield_lock from '@material-symbols/svg-400/outlined/shield_lock.svg?raw';
import smart_toy from '@material-symbols/svg-400/outlined/smart_toy.svg?raw';
import sync from '@material-symbols/svg-400/outlined/sync.svg?raw';
import terminal from '@material-symbols/svg-400/outlined/terminal.svg?raw';
import upload_file from '@material-symbols/svg-400/outlined/upload_file.svg?raw';
import verified_user from '@material-symbols/svg-400/outlined/verified_user.svg?raw';
import warning from '@material-symbols/svg-400/outlined/warning.svg?raw';
import visibility from '@material-symbols/svg-400/outlined/visibility.svg?raw';
import visibility_off from '@material-symbols/svg-400/outlined/visibility_off.svg?raw';

const ICONS = {
  add, arrow_drop_down, block, bolt, check, close, content_copy, dashboard, delete: delete_, download, edit, history, key, layers, lock, lock_open, logout, person,
  power_settings_new, search, shield, shield_lock, smart_toy, sync, terminal, upload_file, verified_user, visibility, visibility_off, warning,
};

/** Material Symbols (outlined) inlined as SVG, so the dashboard makes no network requests for icons or fonts. */
export function Icon({ name, className = '' }) {
  return <span className={`ms ${className}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} />;
}
