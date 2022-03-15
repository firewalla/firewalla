const path = require('path')
const webpack = require('webpack');

module.exports = {
  entry: './api/bin/www',
  target: 'node12.14',
  mode: 'production',
  devtool: 'source-map',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  optimization: {
    minimize: false
  },
  plugins: [
    new webpack.IgnorePlugin({
      resourceRegExp: /^(geoip-lite|vertx|hiredis|uws|utf-8-validate|bufferutil|supports-color|mongodb-client-encryption)$/,
    })
  ]
}
