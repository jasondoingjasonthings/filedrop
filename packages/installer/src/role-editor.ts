// Entry point for FileDrop-Editor-Setup.exe
// Sets the baked-in role before the main installer runs.
process.env['FILEDROP_BUILT_ROLE'] = 'editor';
import './index.js';
