require "test_helper"

# User <-> personal principal: the session-scoped, provider-key-only identity a
# user's Slack / third-party sessions run as.
class UserPrincipalTest < ActiveSupport::TestCase
  test "personal_principal_foreign_id derives from the primary key (not the oid)" do
    user = users(:member_user)
    assert_equal "user-#{user.id}", user.personal_principal_foreign_id
  end

  test "personal_principal find-or-creates a session-scoped principal in the shared namespace" do
    user = users(:member_user)
    principal = nil
    assert_difference -> { Principal.count }, 1 do
      principal = user.personal_principal
    end
    assert principal.session_scoped?
    assert_equal User::PERSONAL_PRINCIPAL_NAMESPACE, principal.namespace
    assert_equal "user-#{user.id}", principal.foreign_id
    assert_equal user, principal.created_by
  end

  test "personal_principal is idempotent" do
    user = users(:member_user)
    first = user.personal_principal
    assert_no_difference -> { Principal.count } do
      assert_equal first, user.personal_principal
    end
  end

  test "personal_principal re-asserts session_scoped on a pre-existing unflagged row" do
    # Mirrors a principal first created by api-rs's upsert (no session_scoped),
    # later adopted when the user registers a key.
    user = users(:member_user)
    pre = Principal.create!(namespace: User::PERSONAL_PRINCIPAL_NAMESPACE,
                            foreign_id: "user-#{user.id}", created_by: user, session_scoped: false)
    principal = user.personal_principal
    assert_equal pre, principal
    assert principal.reload.session_scoped?
  end

  test "existing_personal_principal does not create" do
    user = users(:member_user)
    assert_nil user.existing_personal_principal
    assert_no_difference -> { Principal.count } do
      user.existing_personal_principal
    end
  end

  test "provider_key? is false without a registered key" do
    assert_not users(:member_user).provider_key?
  end

  test "provider_key? is true once a provider-key secret with a deliverable source is granted" do
    user = users(:member_user)
    principal = user.personal_principal
    secret = StaticSecret.create!(
      namespace: User::PERSONAL_PRINCIPAL_NAMESPACE, foreign_id: "user-#{user.id}-openai",
      replace_config: { "proxy_value" => "OPENAI_API_KEY", "match_headers" => %w[Authorization] },
      created_by: user
    )
    SecretSource.create!(source_type: "env", config: { "var" => "OPENAI_API_KEY" }, static_secret: secret)
    Grant.create!(principal: principal, static_secret: secret, created_by: user)
    assert user.provider_key?
  end

  # A provider-key secret with no source delivers no value (Principal#sync_secrets
  # skips it), so the bot would run with no key injected -- it must NOT count as a
  # registered provider key.
  test "provider_key? is false for a granted provider-key secret with no source" do
    user = users(:member_user)
    principal = user.personal_principal
    secret = StaticSecret.create!(
      namespace: User::PERSONAL_PRINCIPAL_NAMESPACE, foreign_id: "user-#{user.id}-openai",
      replace_config: { "proxy_value" => "OPENAI_API_KEY", "match_headers" => %w[Authorization] },
      created_by: user
    )
    Grant.create!(principal: principal, static_secret: secret, created_by: user)
    assert_not user.provider_key?
  end
end
