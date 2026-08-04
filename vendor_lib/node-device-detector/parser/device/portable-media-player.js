const DeviceAbstractParser = require('./../device-abstract-parser');

class PortableMediaPlayer extends DeviceAbstractParser {
  constructor(options) {
    super(options);
    this.fixtureFile = 'device/portable_media_player.yml';
    this.loadCollection();
  }
}

module.exports = PortableMediaPlayer;
