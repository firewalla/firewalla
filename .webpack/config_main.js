const path = require('path')
const webpack = require('webpack');

module.exports = {
  entry: './net2/main.js',
  target: 'node',
  mode: 'production',
  devtool: 'source-map',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'node12.14'
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
