from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}")
    p.write_text(text.replace(old, new), encoding="utf-8")


replace_once(
    "controllers/netbot.js",
    """          if (await c.profileExists(profileId)) {\n            log.warn(`Cleaning up invalid stored VPN client profile ${profileId}`);\n            await pm2.deleteVpnClientRelatedPolicies(profileId);\n""",
    """          if (await c.profileExists(profileId)) {\n            if (await VPNClient.isProfileActive(profileId)) {\n              throw { code: 400, msg: `${type} VPN client ${profileId} is still running` };\n            }\n            log.warn(`Cleaning up invalid stored VPN client profile ${profileId}`);\n            await pm2.deleteVpnClientRelatedPolicies(profileId);\n""",
)

replace_once(
    "extension/vpnclient/VPNClient.js",
    """  static getInstance(profileId) {\n    if (instances.hasOwnProperty(profileId))\n      return instances[profileId];\n    else\n      return null;\n  }\n\n  static async getVPNProfilesForInit() {\n""",
    """  static getInstance(profileId) {\n    if (instances.hasOwnProperty(profileId))\n      return instances[profileId];\n    else\n      return null;\n  }\n\n  static async isProfileActive(profileId) {\n    const instance = VPNClient.getInstance(profileId);\n    if (instance && instance.isStarted())\n      return true;\n\n    return (await rclient.getAsync(VPNClient.getStateCacheKey(profileId))) === \"true\";\n  }\n\n  static async getVPNProfilesForInit() {\n""",
)

replace_once(
    "extension/vpnclient/VPNClient.js",
    """  static async destroyStoredProfile(profileId) {\n    const configDirectory = path.resolve(this.getConfigDirectory());\n    const files = [\".settings\", \".json\", \".endpoint_routes\"];\n\n    for (const suffix of files) {\n      const filePath = path.resolve(configDirectory, `${profileId}${suffix}`);\n      if (filePath !== configDirectory && !filePath.startsWith(`${configDirectory}${path.sep}`)) {\n        log.error(`Refusing to clean VPN client profile outside config directory: ${profileId}`);\n        continue;\n      }\n      await fs.unlinkAsync(filePath).catch(() => { });\n    }\n\n    const primaryProfilePath = this.getPrimaryProfilePath(profileId);\n    if (primaryProfilePath) {\n      const resolvedPath = path.resolve(primaryProfilePath);\n      if (resolvedPath !== configDirectory && !resolvedPath.startsWith(`${configDirectory}${path.sep}`)) {\n        log.error(`Refusing to clean VPN client primary profile outside config directory: ${profileId}`);\n      } else {\n        await fs.unlinkAsync(resolvedPath).catch(() => { });\n      }\n    }\n\n    await rclient.unlinkAsync(VPNClient.getRouteMarkKey(profileId)).catch(() => { });\n    await rclient.delAsync(VPNClient.getStateCacheKey(profileId)).catch(() => { });\n    delete instances[profileId];\n  }\n""",
    """  static async destroyStoredProfile(profileId) {\n    if (!_.isString(profileId) || !Constants.REGEX_FILENAME.test(profileId)) {\n      throw new Error(`Refusing to clean VPN client profile with unsafe filename: ${profileId}`);\n    }\n\n    const configDirectory = path.resolve(this.getConfigDirectory());\n\n    const unlinkFile = async (filePath) => {\n      try {\n        await fs.unlinkAsync(filePath);\n      } catch (err) {\n        if (err && err.code === 'ENOENT')\n          return;\n        throw err;\n      }\n    };\n\n    // Remove dependent files first and the .settings file last.\n    // Keeping .settings on failure preserves discoverability for retry.\n    const files = [\".json\", \".endpoint_routes\"];\n\n    for (const suffix of files) {\n      const filePath = path.resolve(configDirectory, `${profileId}${suffix}`);\n      if (filePath !== configDirectory && !filePath.startsWith(`${configDirectory}${path.sep}`)) {\n        throw new Error(`Refusing to clean VPN client profile outside config directory: ${profileId}`);\n      }\n      await unlinkFile(filePath);\n    }\n\n    const primaryProfilePath = this.getPrimaryProfilePath(profileId);\n    if (primaryProfilePath) {\n      const resolvedPath = path.resolve(primaryProfilePath);\n      if (resolvedPath !== configDirectory && !resolvedPath.startsWith(`${configDirectory}${path.sep}`)) {\n        throw new Error(`Refusing to clean VPN client primary profile outside config directory: ${profileId}`);\n      }\n      await unlinkFile(resolvedPath);\n    }\n\n    await rclient.unlinkAsync(VPNClient.getRouteMarkKey(profileId));\n    await rclient.delAsync(VPNClient.getStateCacheKey(profileId));\n\n    const settingsPath = path.resolve(configDirectory, `${profileId}.settings`);\n    if (settingsPath !== configDirectory && !settingsPath.startsWith(`${configDirectory}${path.sep}`)) {\n      throw new Error(`Refusing to clean VPN client settings outside config directory: ${profileId}`);\n    }\n    await unlinkFile(settingsPath);\n\n    delete instances[profileId];\n  }\n""",
)
