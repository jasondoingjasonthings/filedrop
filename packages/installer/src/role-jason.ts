// Entry point for FileDrop-Jason-Setup.exe
// Sets the baked-in role before the main installer runs.
process.env['FILEDROP_BUILT_ROLE'] = 'jason';
import './index.js';
