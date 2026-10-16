Feature: Init
  jira-local requires some configuration before it can start fetching issues.
  It needs the site and credentials, and which project to pull, and what
  indexes it should create. The `init` command sets this up, by prompting the
  user or through command line options.

  Scenario: A non-interactive init writes a default config
    Given a directory with no config
    When I run "jira-local init --yes"
    Then the exit code is 0
    And the config is
      | site | "https://your-site.atlassian.net" |
      | email | process.env.JIRA_EMAIL |
      | token | process.env.JIRA_API_TOKEN |
      | project | "PROJECTKEY" |
