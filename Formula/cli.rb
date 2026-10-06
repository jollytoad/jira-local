class Cli < Formula
  desc "Mirror a Jira Cloud project to local markdown files"
  homepage "https://github.com/jollytoad/jira-local"
  version "0.1.2"
  on_macos do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-apple-darwin.tar.gz"
      sha256 "f4515e2ae866510872d110f1f83f36a5786d1bc34a564460bb7a0d16e0111f8e"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-apple-darwin.tar.gz"
      sha256 "14f2afcd964dc0dc663b66f43e608cd2127304de85dec8cb7af1fe6dfd1fd363"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "8b461e6e43dabe4e8848ae873cf70abdc739725f3e9418ba939c7350310bcb00"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "347c14a311527a4f3c8ae8a730f1ed38660b5b77cbcd6e0cfc9672b1a882ee5b"
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
