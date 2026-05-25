'use strict';

// Extensions that must never be uploaded — executables, scripts, web server code.
// This is a blocklist, not an allowlist, so legitimate media formats are never
// accidentally rejected as the platform evolves.
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.dll', '.scr', '.com', '.pif',   // Windows executables
  '.bat', '.cmd', '.ps1', '.vbs', '.wsf', '.hta',   // Windows scripts
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.fish',  // Unix shells
  '.py', '.rb', '.pl', '.php', '.php3', '.php4', '.php5', '.phtml', // server-side scripts
  '.asp', '.aspx', '.jsp', '.jspx', '.cfm',          // web server code
  '.jar', '.class', '.war',                          // Java bytecode
  '.app', '.deb', '.rpm', '.pkg',                    // installers
]);

function isBlockedFilename(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return BLOCKED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

module.exports = { isBlockedFilename };
