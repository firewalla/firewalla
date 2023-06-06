const DeviceAbstractParser = require('./../device-abstract-parser');

class PortableMediaPlayer extends DeviceAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'device/portable_media_player.yml';
    this.loadCollection();
  }
}

module.exports = PortableMediaPlayer;
