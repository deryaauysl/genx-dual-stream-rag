// Minimal harness: runs an n8n Code-node file with mocked $input / $ / $env / $json.
const fs = require('fs');
module.exports = function run(file, { items = [], refs = {}, env = {}, json } = {}) {
  const src = fs.readFileSync(file, 'utf8');
  const wrap = (arr) => ({
    all: () => arr, first: () => arr[0],
    itemMatching: (i) => arr[i], get item() { return arr[0]; },
  });
  const $input = wrap(items);
  const $ = (name) => { if (!refs[name]) throw new Error('no ref ' + name); return wrap(refs[name]); };
  const fn = new Function('$input', '$', '$env', '$json', `return (function(){${src}\n})();`);
  return fn($input, $, env, json ?? items[0]?.json);
};
