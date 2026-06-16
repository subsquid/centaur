require "test_helper"

module Console
  # Self-service provider-key page: registering a key creates a host-scoped
  # `replace` static secret + a grant to the user's own session-scoped principal,
  # the key is write-only, and a user only ever touches their own principal.
  class ProviderKeysControllerTest < ActionDispatch::IntegrationTest
    setup do
      @user = users(:member_user)
      post login_url, params: { email: @user.email, password: "password123456" }
    end

    test "redirects to login when not signed in" do
      delete logout_url
      get console_provider_keys_url
      assert_redirected_to login_path
    end

    test "GET show renders a section per provider" do
      get console_provider_keys_url
      assert_response :ok
      assert_select "h2", text: "Anthropic"
      assert_select "h2", text: "OpenAI"
    end

    test "PATCH registers a key as a host-scoped replace secret granted to the personal principal" do
      assert_difference -> { StaticSecret.count } => 1, -> { Grant.count } => 1 do
        patch console_provider_key_url("anthropic"), params: { key: "sk-ant-live" }
      end
      assert_redirected_to console_provider_keys_path

      secret = StaticSecret.find_by!(namespace: "default", foreign_id: "user-#{@user.id}-anthropic")
      assert secret.provider_key?
      assert_equal({ "proxy_value" => "ANTHROPIC_API_KEY", "match_headers" => %w[X-Api-Key] }, secret.replace_config)
      assert_nil secret.inject_config
      assert_equal "control_plane", secret.source.source_type
      assert_equal "sk-ant-live", secret.source.secret
      assert_equal %w[api.anthropic.com], secret.rules.map(&:host)

      principal = @user.personal_principal
      assert principal.session_scoped?
      assert Grant.exists?(principal: principal, static_secret: secret)
      assert_equal @user, secret.created_by
    end

    test "PATCH with a blank key on a brand-new provider is rejected without writing" do
      assert_no_difference -> { StaticSecret.count } do
        patch console_provider_key_url("anthropic"), params: { key: "" }
      end
      assert_response :unprocessable_entity
    end

    test "the key is write-only: a blank key on a later save keeps the stored value" do
      patch console_provider_key_url("openai"), params: { key: "sk-openai-original" }
      secret = StaticSecret.find_by!(foreign_id: "user-#{@user.id}-openai")

      patch console_provider_key_url("openai"), params: { key: "" }
      assert_redirected_to console_provider_keys_path
      assert_equal "sk-openai-original", secret.reload.source.secret
    end

    test "entering a new key replaces the stored value" do
      patch console_provider_key_url("openai"), params: { key: "sk-old" }
      patch console_provider_key_url("openai"), params: { key: "sk-new" }
      secret = StaticSecret.find_by!(foreign_id: "user-#{@user.id}-openai")
      assert_equal "sk-new", secret.reload.source.secret
    end

    test "re-saving does not create a duplicate secret or grant" do
      patch console_provider_key_url("anthropic"), params: { key: "sk-1" }
      assert_no_difference [ "StaticSecret.count", "Grant.count", "SecretSource.count" ] do
        patch console_provider_key_url("anthropic"), params: { key: "sk-2" }
      end
    end

    test "DELETE removes the key, its grant, and its source" do
      patch console_provider_key_url("anthropic"), params: { key: "sk-ant" }
      secret = StaticSecret.find_by!(foreign_id: "user-#{@user.id}-anthropic")

      assert_difference -> { StaticSecret.count } => -1, -> { Grant.count } => -1 do
        delete console_provider_key_url("anthropic")
      end
      assert_redirected_to console_provider_keys_path
      assert_not StaticSecret.exists?(secret.id)
      assert_not SecretSource.exists?(static_secret_id: secret.id)
    end

    test "an unknown provider redirects with an alert and writes nothing" do
      assert_no_difference -> { StaticSecret.count } do
        patch console_provider_key_url("gemini"), params: { key: "x" }
      end
      assert_redirected_to console_provider_keys_path
      assert_equal "Unknown provider.", flash[:alert]
    end

    test "a user only ever registers a key against their own principal" do
      patch console_provider_key_url("anthropic"), params: { key: "sk-mine" }
      grant = Grant.find_by!(static_secret: StaticSecret.find_by!(foreign_id: "user-#{@user.id}-anthropic"))
      assert_equal @user.personal_principal, grant.principal
      assert_equal "user-#{@user.id}", grant.principal.foreign_id
    end
  end
end
