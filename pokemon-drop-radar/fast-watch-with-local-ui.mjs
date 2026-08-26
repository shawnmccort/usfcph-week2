import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const sourcePath='pokemon-drop-radar/fast-watch.mjs';
const patchPath='pokemon-drop-radar/local-ui-save-patch.mjsfrag';
const outputPath='/tmp/pokemon-fast-watch-with-local-ui.mjs';

const source=await fs.readFile(sourcePath,'utf8');
const patch=(await fs.readFile(patchPath,'utf8')).trimEnd();
const start=source.indexOf('async function saveState(state){');
if(start<0)throw new Error('Could not locate saveState() in fast-watch.mjs');
const end=source.indexOf('\n}\n\nfunction blocked',start);
if(end<0)throw new Error('Could not locate end of saveState() in fast-watch.mjs');
const generated=source.slice(0,start)+patch+source.slice(end+2);
await fs.writeFile(outputPath,generated,'utf8');
await import(`${pathToFileURL(outputPath).href}?t=${Date.now()}`);
