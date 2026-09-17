class Cli < Formula
  desc "Mirror a Jira Cloud project to local markdown files"
  homepage "https://github.com/jollytoad/jira-local"
  version "0.1.1"
  on_macos do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-apple-darwin.tar.gz"
      sha256 "5d1fd3676cbf1dc05b05df295bfa56635f87e4a0b76d7c9467bd0a57f66ac6ac"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-apple-darwin.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end
  def install
    bin.install "jira-local"
  end
  livecheck do
    url "https://github.com/jollytoad/jira-local"
    strategy :github_releases
  end
end
