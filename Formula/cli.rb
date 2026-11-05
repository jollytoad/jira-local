class Cli < Formula
  desc "Mirror a Jira Cloud project to local markdown files"
  homepage "https://github.com/jollytoad/jira-local"
  version "0.3.1"
  on_macos do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-apple-darwin.tar.gz"
      sha256 "834c276e8c563327aaaee28c82db4688185862e9972818ad101ba75a6b104ef2"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-apple-darwin.tar.gz"
      sha256 "5d147521d9174866b434ac08da282a8a510c0882521863c5291fef8bafd5e083"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "c661e02ce9e08be712ff0a22e519ea926af84acca28d7d680220914853040561"
    end
    on_intel do
      url "https://github.com/jollytoad/jira-local/releases/download/v#{version}/jira-local-v#{version}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "9e4aab28c4a701dbf02d7fe58ce0b84551997c8e3eadc66742cc3f66f9f3848b"
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
