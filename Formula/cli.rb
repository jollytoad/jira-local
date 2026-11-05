class Cli < Formula
  desc "Mirror a Jira Cloud project to local markdown files"
  homepage "https://github.com/jollytoad/jira-local"
  version "0.3.0"
  on_macos do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-apple-darwin.tar.gz"
      sha256 "8cb79a781dcce4ff7a754bd3ce602cf809becc326aa5281445fc41095f3b12fe"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-apple-darwin.tar.gz"
      sha256 "5e142c536f078c7264786b35a58768dc03a1448213fc30ce5cd90f5d15c6dc72"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "941c4f7567efe617ef317c24827efc7b09f2c7c5733a90a76832ef3349a3996d"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "dccc79232a15c8230fa2ba093a73df2be52f9a05fee98329612ab7b8b390c31c"
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
