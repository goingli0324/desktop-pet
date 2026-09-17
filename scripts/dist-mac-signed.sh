#!/bin/bash
# 正式發佈用：Developer ID 簽章 + Apple notarize。
# 帳密不在 repo：從 ~/.config/desktop-pet/notarize.env 讀（範本見 README「正式簽章」）。
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="$HOME/.config/desktop-pet/notarize.env"
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE，請照 README「正式簽章」建立"; exit 1; }
set -a; source "$ENV_FILE"; set +a
for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  [ -n "${!v:-}" ] || { echo "$ENV_FILE 缺 $v"; exit 1; }
done
security find-identity -v -p codesigning | grep -q "Developer ID Application" || { echo "keychain 沒有 Developer ID Application 憑證，先用 Xcode → Settings → Accounts → Manage Certificates 建立"; exit 1; }
npx electron-builder --mac -c.mac.notarize=true "$@"
echo "完成。驗證：spctl -a -vv -t install \"dist/mac-arm64/Desktop Pet.app\" 應回 accepted / source=Notarized Developer ID"
