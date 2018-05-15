var utils = exports;

utils.getNamespace = function getNamespace(data, uri) {
  var ns;

  if (data['@']) {
    Object.keys(data['@']).some(function(key) {
      if (!/^xmlns:/.test(key)) return;
      if (data['@'][key] !== uri) {
        return;
      }

      ns = key.replace(/^xmlns:/, '');
      return true;
    });
  }

  return ns ? ns + ':' : '';
};
