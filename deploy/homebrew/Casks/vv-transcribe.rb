cask "vv-transcribe" do
  version :latest
  sha256 :no_check

  on_arm do
    url "https://github.com/DaQI-X/Vv-Transcribe/releases/latest/download/Vv-Transcribe-mac-arm64.dmg"
  end

  on_intel do
    url "https://github.com/DaQI-X/Vv-Transcribe/releases/latest/download/Vv-Transcribe-mac-x64.dmg"
  end

  name "Vv Transcribe"
  desc "Local AI subtitle transcription and proofreading tool for media professionals"
  homepage "https://vvscribe.com/"

  app "Vv Transcribe.app"

  caveats <<~EOS
    Vv Transcribe is an open-source personal project and is NOT code-signed.
    On first launch macOS Gatekeeper may report it as from an unidentified developer.
    If that happens, right-click the app and choose Open, or run:
      xattr -cr "/Applications/Vv Transcribe.app"
  EOS

  zap trash: [
    "~/Library/Application Support/Vv Transcribe",
    "~/Library/Caches/vv-asr-server",
    "~/Library/Preferences/com.vv.transcribe.plist",
  ]
end
