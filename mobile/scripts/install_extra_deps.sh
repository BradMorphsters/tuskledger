#!/usr/bin/env bash
# Installs the deps that aren't in the create-expo-app baseline but
# that the Tusk Ledger app needs:
#   - expo-camera, expo-network, expo-secure-store, expo-sqlite
#       → Expo-managed, installed via `npx expo install` so versions
#         match the SDK the project is on.
#   - @react-navigation/* + zustand + RN gesture/safe-area/screens
#       → React-side libs, installed via npm. Versions float to whatever
#         the resolver picks compatible with React 19.
#   - react-native-zeroconf
#       → Community native module. May complain about peer deps with
#         React 19; the script falls back to --legacy-peer-deps if so.
#
# Run from the project root:
#     bash scripts/install_extra_deps.sh
set -e

cd "$(dirname "$0")/.."

echo "==> Installing Expo SDK packages…"
npx expo install \
  expo-camera \
  expo-network \
  expo-secure-store \
  expo-sqlite

echo "==> Installing React Navigation + state management…"
# react-native-zeroconf is the one most likely to need --legacy-peer-deps
# under React 19 (its declared peer range is older). Try the strict
# install first; on failure, retry with the looser flag so we don't
# block the whole tree on one upstream lag.
if ! npm install \
  @react-navigation/native \
  @react-navigation/bottom-tabs \
  @react-navigation/native-stack \
  zustand \
  react-native-gesture-handler \
  react-native-safe-area-context \
  react-native-screens \
  react-native-zeroconf
then
  echo "==> Strict install failed, retrying with --legacy-peer-deps…"
  npm install --legacy-peer-deps \
    @react-navigation/native \
    @react-navigation/bottom-tabs \
    @react-navigation/native-stack \
    zustand \
    react-native-gesture-handler \
    react-native-safe-area-context \
    react-native-screens \
    react-native-zeroconf
fi

echo
echo "==> Done. Start Metro with:"
echo "    npx expo start --clear"
