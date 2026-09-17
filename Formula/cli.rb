class Cli < Formula
  desc "Mirror a Jira Cloud project to local markdown files"
  homepage "https://github.com/jollytoad/jira-local"
  version "0.1.1"
  on_macos do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-apple-darwin.tar.gz"
      sha256 "d70ed432b8c177f68536490e1f13db56de1e4ea4c6197dbf20558b415f225575"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-apple-darwin.tar.gz"
      sha256 "40c1a3038cebccf57fcc9a7d17d5efdb0318bc63650766cdb1f4c84b536cd1ed"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "534e90839aecd8f1f138a8627478c8b44129a2c24d410110f8c92ed29fc08f15"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "86dcb8b7b35b95d7850131ab483b01fa8e6b1dd13e3b174aa875876b7fbeaf2a"
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
