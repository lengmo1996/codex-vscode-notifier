'use strict';

// Read-only, bounded reproduction of the installed VS Code URL router's
// numeric window-id prefix match. No VS Code process, settings or UI are used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function mainFile(argv) {
  if (argv.length === 2 && argv[0] === '--main' && path.isAbsolute(argv[1])) return argv[1];
  if (argv.length) throw new Error('Usage: node reproduce-url-window-routing.js [--main <absolute main.js path>]');
  const configured = process.env.CODEX_NOTIFIER_VSCODE_MAIN;
  if (configured && path.isAbsolute(configured)) return configured;
  throw new Error('Provide --main <absolute main.js path> or CODEX_NOTIFIER_VSCODE_MAIN; no installation version is assumed');
}

function reproduce(file) {
  const size = fs.statSync(file).size;
  if (size > 64 * 1024 * 1024) throw new Error('Refusing to inspect a main.js larger than 64 MiB');
  const bytes = fs.readFileSync(file);
  const source = bytes.toString('utf8');
  const anchor = source.indexOf('URLHandlerRouter#routeCall() with URI argument');
  if (anchor < 0) throw new Error('Installed source does not contain the expected URLHandlerRouter');
  const excerpt = source.slice(Math.max(0, anchor - 200), anchor + 1400);

  // Assert the actual installed code's parser, regex construction and first
  // matching connection selection. Stop if this code has changed; do not
  // silently demonstrate a historical implementation against a newer build.
  const parser = excerpt.match(/\/\\bwindowId=\(\\d\+\)\/\.exec\(\w+\.query\)/u);
  const matcher = excerpt.match(/let (\w+)=new RegExp\(`window:\$\{(\w+)\}`\),/u);
  if (!parser || !matcher) throw new Error('The expected unbounded window-id regex is absent; no reproduction asserted');
  const regexVariable = matcher[1];
  const selector = excerpt.match(/\.connections\.find\((\w+)=>\([^;]*?\)\)/u);
  if (!selector || !selector[0].includes(`${regexVariable}.test(${selector[1]}.ctx)`)) {
    throw new Error('The expected first-matching-connection selection is absent; no reproduction asserted');
  }

  // Reconstruct only the two verified regular expressions. Never evaluate
  // the installed JavaScript or import its application entry point.
  const parserText = parser[0].slice(1, parser[0].indexOf('/.exec'));
  const parseWindowId = new RegExp(parserText);
  const query = 'windowId=1';
  const requestedWindowId = parseWindowId.exec(query)?.[1];
  if (requestedWindowId !== '1') throw new Error('Unexpected query-parser result');
  const connectionMatcher = new RegExp('window:' + requestedWindowId);
  const contexts = ['window:16', 'window:1'];
  const selectedContext = contexts.find(context => connectionMatcher.test(context));
  if (selectedContext !== 'window:16') throw new Error('The expected prefix collision was not reproduced');

  return {
    source: {file: path.basename(file), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      routerCharacterOffset: anchor, verifiedParser: parser[0], verifiedMatcher: matcher[0],
      verifiedSelection: '.connections.find(...regex.test(connection.ctx))'},
    input: {query, contexts},
    result: {expectedContext: 'window:1', selectedContext, prefixCollisionReproduced: true},
    scope: 'Simulation of verified installed matching logic; no live window routing or application changes.'
  };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(reproduce(mainFile(process.argv.slice(2))), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({verified: false, error: error.message}) + '\n'); process.exitCode = 1; }
}

module.exports = {mainFile, reproduce};
