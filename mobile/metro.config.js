const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// The app shares the client logic with the desktop app and the server's wire types and avatar sheet layout, and its demo computer wears the starter avatars.
config.watchFolders = [path.resolve(__dirname, "../client"), path.resolve(__dirname, "../server/src"), path.resolve(__dirname, "../avatars")];
// An avatar's picture is outside the app's folder, and what Metro loads it with is among the app's packages.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
