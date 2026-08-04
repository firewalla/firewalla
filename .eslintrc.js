module.exports = {
  "env": {
    "commonjs": true,
    "es6": true,
    "es2020": true,
    "mocha": true,
    "node": true
  },
  "extends": "eslint:recommended",
  "globals": {
    "Atomics": "readonly",
    "SharedArrayBuffer": "readonly"
  },
  "parserOptions": {
    "ecmaVersion": 2022
  },
  "ignorePatterns": [
    '/vendor_lib/**',
    '/api/**',
    '/ui/**',
    '/testLegacy/**',
    '/encipher/lib/Math.uuid.js',
    '/httpd/**',
    '/extension/httpd/**',
    '/lib/**',
  ],
  "rules": {
    "require-atomic-updates": 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-unused-vars': ['warn', { vars: 'all', args: 'none', caughtErrors: 'none' }],
    'no-extra-boolean-cast': ['warn'],
    'no-fallthrough': ['warn'],
    "no-prototype-builtins": 'off',
    'no-extra-semi': 'warn',
    'no-unreachable': 'off',
    'no-inner-declarations': 'off',
    'no-control-regex': 'off',
    'no-constant-condition': 'warn', // todo, better turn on
    'no-useless-escape': 'warn',
    'no-mixed-spaces-and-tabs': 'off',
    'no-case-declarations': 'warn',// todo, better turn on 
    'no-unsafe-negation': 'warn',
    'no-unsafe-finally': 'warn',
    'no-cond-assign': ['warn'], // allow if (a = b)
  }
};
