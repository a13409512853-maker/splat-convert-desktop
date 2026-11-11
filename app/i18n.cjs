const catalog = require('./locales.json');
const codes = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'];
function translate(language, key) { return catalog[key]?.[Math.max(0, codes.indexOf(language))] || key; }
module.exports = { catalog, codes, translate };
