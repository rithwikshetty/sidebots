const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// The app shares the server's wire types and avatar sheet layout.
config.watchFolders = [path.resolve(__dirname, "../server/src")];

module.exports = config;
