class AddSessionScopedToPrincipals < ActiveRecord::Migration[8.1]
  # A session-scoped principal is a user's personal, provider-key-only identity
  # (see User#personal_principal): it may hold ONLY provider-key grants
  # (ANTHROPIC_API_KEY / OPENAI_API_KEY static secrets), enforced in Grant. A
  # Slack/third-party session runs as this principal, so a prompt-injection in
  # untrusted thread context can at most spend the owner's LLM key -- never reach
  # the owner's other brokered secrets.
  #
  # Defaults false: every existing principal is an ordinary operator principal,
  # unaffected and free to hold any grant.
  def change
    add_column :principals, :session_scoped, :boolean, null: false, default: false
  end
end
