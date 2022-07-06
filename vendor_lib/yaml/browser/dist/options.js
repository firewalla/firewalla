/**
 * `yaml` defines document-specific options in three places: as an argument of
 * parse, create and stringify calls, in the values of `YAML.defaultOptions`,
 * and in the version-dependent `YAML.Document.defaults` object. Values set in
 * `YAML.defaultOptions` override version-dependent defaults, and argument
 * options override both.
 */
const defaultOptions = {
    intAsBigInt: false,
    keepSourceTokens: false,
    logLevel: 'warn',
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: '1.2'
};

export { defaultOptions };
