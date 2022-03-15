const path = require('path')
const webpack = require('webpack');

module.exports = {
  entry: './sys/kickstart.js',
  target: 'node',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: 'node.js',
    libraryTarget: 'umd',
    libraryExport: 'default'
  },
  resolve: {
    modules: [
      path.resolve(__dirname, '../node_modules'),
      path.resolve(__dirname, '../webpack/node_modules'),
      path.resolve(__dirname, '../fnm/node_modules')
    ]
  },
  plugins: [
    new webpack.IgnorePlugin({
      resourceRegExp: /^(geoip-lite|vertx|hiredis|uws|utf-8-validate|bufferutil|supports-color|mongodb-client-encryption|uuid\/v4|colors\/safe|dns-equal|multicast-dns|dns-txt|multicast-dns-service-types|ursa|bleno|yamlparser|heapdump)$/,
    })
  ]
}
