'use strict';

// What the page cannot do inside its window, done by the engine on the Windows desktop: open a link
// in the default browser, put text on the clipboard, show a folder picker, open a folder in Explorer.
// steam:// links are not handled here; steam.js does that.
// Trap: nothing the page sends is placed inside a command line. Links must match SAFE_LINK, and
// text and folder names travel in environment variables.

const { execFile, spawn } = require('node:child_process');
const paths = require('./paths');
const { bad_request, not_found } = require('./errors');

// A link straight from the fixes tab. The WebView2 window drops window.open() popups, so the engine
// hands the url to the shell instead - the same door steam:// links already use.
// The shape of a link this app is allowed to hand to Windows: https anywhere, plain http only on this
// machine. A local run of the site is a real door for whoever is building it, and nothing else gets to
// be opened as http - the guard exists so a page cannot launch file:// or a shell, not to stop the
// person who owns the box from testing their own site.
const SAFE_LINK = /^(?:https:\/\/[\w.-]+|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?)\/[^\s"'`<>&|^]*$/i;

function open_link(url) {
  const u = String(url || '').trim();
  // No quotes, no shell metacharacters: this is the same `start "" <url>` shape the steam:// links
  // already use, and it resolves through the user's default browser.
  if (!SAFE_LINK.test(u)) throw bad_request('that is not a link we can open');
  execFile('cmd', ['/c', 'start', '""', u], { windowsHide: true });
  return { opened: u };
}

// The one thing the page cannot do reliably: WebView2 refuses the clipboard API while the window
// is not focused, and the old execCommand path fails the same way. The engine is a normal process
// in the same session, so it can just put the text on the clipboard itself. The text travels in an
// environment variable, never inside the command line, so nothing needs quoting.
function put_clipboard(text) {
  const value = String(text || '');
  if (!value) throw bad_request('nothing to copy');
  if (value.length > 4096) throw bad_request('that is too much to copy');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:STEAMAR_CLIP'], {
      env: { ...process.env, STEAMAR_CLIP: value },
      windowsHide: true,
    });
    let noise = '';
    child.stderr.on('data', (chunk) => { noise += String(chunk).slice(0, 300); });
    child.on('error', (err) => reject(new Error(`clipboard: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve({ copied: value.length });
      else reject(new Error(`clipboard: ${noise.trim() || `powershell exited ${code}`}`));
    });
  });
}

// A native folder picker, because typing C:\Program Files\... is not a friendly thing to ask.
// `start` is the folder the row already points at, so the dialog opens there and not wherever
// Windows last left it.
//
// The title and the folder go through the environment, not into the script: PowerShell ends a
// single-quoted string at a curly quote as well as at ', so doubling ' is not enough to keep a title or
// a folder name from becoming a command.
function pick_folder(title, start) {
  const here = start && paths.exists(start) ? String(start) : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = "Minimized"',
    '$owner.Show()',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dlg.Description = $env:STEAMAR_TITLE',
    '$dlg.ShowNewFolderButton = $true',
    here ? '$dlg.SelectedPath = $env:STEAMAR_START' : '',
    'if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
    '$owner.Close()',
  ].filter(Boolean).join('; ');

  return new Promise((resolve, reject) => {
    const env = { ...process.env, STEAMAR_TITLE: String(title), STEAMAR_START: here };
    execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { timeout: 300000, env }, (err, stdout) => {
      const picked = String(stdout || '').trim();
      if (err || !picked) return reject(new Error('no folder picked'));
      resolve(picked);
    });
  });
}
// Which folder a Settings row is about, taken from config instead of trusted from the page.
function folder_for(key) {
  if (key === 'steam_root') return paths.steam_root();
  if (key === 'stplug_in') return paths.stplug_in();
  if (key === 'depotcache') return paths.depotcache();
  if (key === 'dll_source') return paths.dll_source();
  return '';
}

function reveal(target) {
  const map = {
    steam: paths.steam_root(),
    stplug_in: paths.stplug_in(),
    depotcache: paths.depotcache(),
    out: paths.out_dir(),
    project: paths.project_root(),
  };
  const dir = map[target];
  if (!dir) throw bad_request(`unknown target ${target}`);
  if (!paths.exists(dir)) throw not_found(`missing ${dir}`);
  execFile('explorer.exe', [dir]);
  return { opened: dir };
}

module.exports = { open_link, put_clipboard, pick_folder, folder_for, reveal };
